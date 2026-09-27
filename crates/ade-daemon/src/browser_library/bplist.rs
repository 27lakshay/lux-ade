//! A bounded reader for Apple binary property lists (`bplist00`), enough to
//! read Safari's `Bookmarks.plist`. Pure: bytes in, a value tree out.
//!
//! The file is untrusted input. Every offset is range-checked, a reference
//! cycle fails instead of recursing, nesting stops at `MAX_DEPTH`, and the
//! decoded tree stops at `MAX_NODES` so shared references cannot blow up.
//! `data`, `date`, `real` and `uid` objects are kept only as markers: Safari
//! bookmarks need none of their contents.
//!
//! Format: <https://opensource.apple.com/source/CF/CF-1153.18/CFBinaryPList.c>
use anyhow::{Result, bail, ensure};

const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 2_000_000;
const TRAILER: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub enum Plist {
    Null,
    Bool(bool),
    Int(i64),
    /// A real, date, data or UID object; its contents are not decoded.
    Opaque,
    String(String),
    Array(Vec<Plist>),
    Dict(Vec<(String, Plist)>),
}

impl Plist {
    pub fn get(&self, key: &str) -> Option<&Plist> {
        match self {
            Plist::Dict(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Plist::String(value) => Some(value),
            _ => None,
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offsets: Vec<usize>,
    reference_size: usize,
    nodes: usize,
    active: Vec<bool>,
}

fn be(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
}

impl Reader<'_> {
    fn slice(&self, start: usize, len: usize) -> Result<&[u8]> {
        let end = start.checked_add(len);
        match end {
            Some(end) if end <= self.bytes.len() => Ok(&self.bytes[start..end]),
            _ => bail!("Property list object runs past the end of the file"),
        }
    }

    /// The count in a marker's low nibble, or the integer object after it.
    /// Returns the count and where the object's payload starts.
    fn count(&self, offset: usize, low: u8) -> Result<(usize, usize)> {
        if low != 0x0f {
            return Ok((usize::from(low), offset + 1));
        }
        let marker = *self.slice(offset + 1, 1)?.first().unwrap_or(&0);
        ensure!(marker >> 4 == 0x1, "Property list count is not an integer");
        let width = 1usize << (marker & 0x0f);
        ensure!(width <= 8, "Property list count is too wide");
        let value = be(self.slice(offset + 2, width)?);
        let count = usize::try_from(value)?;
        ensure!(
            count <= self.bytes.len(),
            "Property list count exceeds the file"
        );
        Ok((count, offset + 2 + width))
    }

    fn reference(&self, at: usize) -> Result<usize> {
        let index = usize::try_from(be(self.slice(at, self.reference_size)?))?;
        ensure!(
            index < self.offsets.len(),
            "Property list reference is out of range"
        );
        Ok(index)
    }

    fn references(&self, start: usize, count: usize) -> Result<Vec<usize>> {
        let span = count
            .checked_mul(self.reference_size)
            .ok_or_else(|| anyhow::anyhow!("Property list container is too large"))?;
        self.slice(start, span)?;
        (0..count)
            .map(|i| self.reference(start + i * self.reference_size))
            .collect()
    }

    fn object(&mut self, index: usize, depth: usize) -> Result<Plist> {
        ensure!(depth <= MAX_DEPTH, "Property list nests too deeply");
        self.nodes += 1;
        ensure!(
            self.nodes <= MAX_NODES,
            "Property list has too many objects"
        );
        ensure!(
            !self.active[index],
            "Property list contains a reference cycle"
        );
        let offset = self.offsets[index];
        let marker = *self.slice(offset, 1)?.first().unwrap_or(&0);
        let (kind, low) = (marker >> 4, marker & 0x0f);
        let value = match kind {
            0x0 => match low {
                0x0 => Plist::Null,
                0x8 => Plist::Bool(false),
                0x9 => Plist::Bool(true),
                _ => bail!("Unsupported property list marker"),
            },
            0x1 => {
                let width = 1usize << low;
                ensure!(width <= 16, "Property list integer is too wide");
                let raw = self.slice(offset + 1, width)?;
                // Narrow integers are unsigned; 8 bytes is two's complement,
                // and a 16-byte integer holds its value in the low half.
                Plist::Int(be(&raw[raw.len().saturating_sub(8)..]) as i64)
            }
            0x2 | 0x3 | 0x8 => Plist::Opaque,
            0x4 => {
                let (len, start) = self.count(offset, low)?;
                self.slice(start, len)?;
                Plist::Opaque
            }
            0x5 => {
                let (len, start) = self.count(offset, low)?;
                let raw = self.slice(start, len)?;
                ensure!(raw.is_ascii(), "Property list ASCII string is not ASCII");
                Plist::String(String::from_utf8(raw.to_vec())?)
            }
            0x6 => {
                let (len, start) = self.count(offset, low)?;
                let raw = self.slice(start, len.saturating_mul(2))?;
                let units: Vec<u16> = raw
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_be_bytes(*pair))
                    .collect();
                Plist::String(String::from_utf16(&units)?)
            }
            0xa | 0xc => {
                let (len, start) = self.count(offset, low)?;
                let children = self.references(start, len)?;
                self.active[index] = true;
                let items = children
                    .into_iter()
                    .map(|child| self.object(child, depth + 1))
                    .collect::<Result<Vec<_>>>();
                self.active[index] = false;
                Plist::Array(items?)
            }
            0xd => {
                let (len, start) = self.count(offset, low)?;
                let keys = self.references(start, len)?;
                let values = self.references(start + len * self.reference_size, len)?;
                self.active[index] = true;
                let mut entries = Vec::with_capacity(len.min(1024));
                let mut failure = None;
                for (key, value) in keys.into_iter().zip(values) {
                    let decoded = self.object(key, depth + 1).and_then(|key| match key {
                        Plist::String(key) => Ok(key),
                        _ => bail!("Property list dictionary key is not a string"),
                    });
                    match decoded.and_then(|key| Ok((key, self.object(value, depth + 1)?))) {
                        Ok(entry) => entries.push(entry),
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
                self.active[index] = false;
                if let Some(error) = failure {
                    return Err(error);
                }
                Plist::Dict(entries)
            }
            _ => bail!("Unsupported property list object type"),
        };
        Ok(value)
    }
}

/// Parses a whole `bplist00` file.
pub fn parse(bytes: &[u8]) -> Result<Plist> {
    ensure!(
        bytes.len() >= 8 + TRAILER && bytes.starts_with(b"bplist00"),
        "Not a binary property list (bplist00)"
    );
    let trailer = &bytes[bytes.len() - TRAILER..];
    let offset_size = usize::from(trailer[6]);
    let reference_size = usize::from(trailer[7]);
    ensure!(
        (1..=8).contains(&offset_size) && (1..=8).contains(&reference_size),
        "Property list trailer is invalid"
    );
    let count = usize::try_from(be(&trailer[8..16]))?;
    let top = usize::try_from(be(&trailer[16..24]))?;
    let table = usize::try_from(be(&trailer[24..32]))?;
    let table_end = count
        .checked_mul(offset_size)
        .and_then(|len| len.checked_add(table))
        .ok_or_else(|| anyhow::anyhow!("Property list offset table is invalid"))?;
    ensure!(
        count > 0 && count <= MAX_NODES && top < count && table >= 8,
        "Property list trailer is invalid"
    );
    ensure!(
        table_end <= bytes.len() - TRAILER,
        "Property list offset table runs past the file"
    );
    let offsets = (0..count)
        .map(|i| {
            let at = table + i * offset_size;
            let offset = usize::try_from(be(&bytes[at..at + offset_size]))?;
            ensure!(
                (8..table).contains(&offset),
                "Property list object offset is out of range"
            );
            Ok(offset)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut reader = Reader {
        bytes,
        offsets,
        reference_size,
        nodes: 0,
        active: vec![false; count],
    };
    reader.object(top, 0)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A Safari-shaped `Bookmarks.plist`, converted by `plutil -convert
    /// binary1`: a proxy, a folder with an HTTPS leaf (with a non-ASCII title
    /// and a `Sync` data blob) and a `javascript:` leaf.
    pub const SAFARI_BOOKMARKS: &str = "\
62706c6973743030d401020304051d0b1e584368696c6472656e555469746c65\
5f100f576562426f6f6b6d61726b547970655f1016576562426f6f6b6d61726b\
46696c6556657273696f6ea20609d20203070857486973746f72795f10145765\
62426f6f6b6d61726b5479706550726f7879d30203010a0b0c5c426f6f6b6d61\
726b734261725f1013576562426f6f6b6d61726b547970654c697374a20d19d4\
0e030f10111213165955524c537472696e675453796e635d5552494469637469\
6f6e6172795f101568747470733a2f2f6578616d706c652e746573742f5f1013\
576562426f6f6b6d61726b547970654c656166d11415544461746143000102d1\
1718557469746c65670045007800e4006d0070006c0065d310030e1a121cd117\
1b565363726970745f10136a6176617363726970743a616c6572742831295010\
0100080011001a00200032004b004e0053005b007200790086009c009f00a800\
b200b700c500dd00f300f600fb00ff010201080117011e01210128013e013f00\
00000000000201000000000000001f00000000000000000000000000000141";

    pub fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn reads_a_safari_bookmarks_file() {
        let root = parse(&hex(SAFARI_BOOKMARKS)).unwrap();
        assert_eq!(root.get("WebBookmarkFileVersion"), Some(&Plist::Int(1)));
        let Some(Plist::Array(children)) = root.get("Children") else {
            panic!("children")
        };
        assert_eq!(children.len(), 2);
        let Some(Plist::Array(leaves)) = children[1].get("Children") else {
            panic!("leaves")
        };
        let title = leaves[0].get("URIDictionary").and_then(|d| d.get("title"));
        assert_eq!(title.and_then(Plist::as_str), Some("Exämple"));
        assert_eq!(
            leaves[0].get("Sync").and_then(|s| s.get("Data")),
            Some(&Plist::Opaque)
        );
    }

    #[test]
    fn damaged_files_fail_instead_of_reading_out_of_range() {
        let good = hex(SAFARI_BOOKMARKS);
        assert!(parse(b"bplist00").is_err());
        assert!(parse(&good[..good.len() - 1]).is_err());
        let mut wrong_magic = good.clone();
        wrong_magic[7] = b'1';
        assert!(parse(&wrong_magic).is_err());
        // Every single-byte truncation or corruption either parses or fails;
        // none panics.
        for cut in 0..good.len() {
            let _ = parse(&good[..cut]);
            let mut bad = good.clone();
            bad[cut] ^= 0xff;
            let _ = parse(&bad);
        }
    }

    #[test]
    fn a_reference_cycle_fails() {
        // One array (object 0) whose only element is itself.
        let mut bytes = b"bplist00".to_vec();
        bytes.extend([0xa1, 0x00]); // array of 1, ref 0
        let table = bytes.len();
        bytes.push(8); // offset of object 0
        let mut trailer = vec![0u8; 6];
        trailer.extend([1, 1]);
        trailer.extend(1u64.to_be_bytes());
        trailer.extend(0u64.to_be_bytes());
        trailer.extend((table as u64).to_be_bytes());
        bytes.extend(trailer);
        let error = parse(&bytes).unwrap_err().to_string();
        assert!(error.contains("cycle"), "{error}");
    }
}
