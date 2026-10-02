//! Allocation-free admission before parsing native/provider JSON into a value tree.
//! Limits count all values and object keys, including unknown native properties.

pub const MAX_NODES: usize = 4096;
pub const MAX_DEPTH: usize = 64;
pub const MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;

/// Conservative decoded tree plus projection reservation, not measured allocator bytes.
#[derive(Clone, Copy, Default)]
pub struct Usage {
    pub bytes: usize,
    pub nodes: usize,
}
impl Usage {
    pub fn reservation(self) -> usize {
        self.bytes * 4 + self.nodes * 512
    }
    pub fn fits_with(self, other: Self, max_bytes: usize) -> bool {
        self.bytes.saturating_add(other.bytes) <= max_bytes
            && self.nodes.saturating_add(other.nodes) <= MAX_NODES
            && self.reservation().saturating_add(other.reservation()) <= MAX_DECODED_BYTES
    }
    pub fn add(&mut self, other: Self) {
        self.bytes += other.bytes;
        self.nodes += other.nodes;
    }
}
struct Scanner {
    usage: Usage,
    max_bytes: usize,
    depth: usize,
    string: bool,
    escaped: bool,
    primitive: bool,
    rejected: bool,
}
impl Scanner {
    fn new(max_bytes: usize) -> Self {
        Self {
            usage: Usage::default(),
            max_bytes,
            depth: 0,
            string: false,
            escaped: false,
            primitive: false,
            rejected: false,
        }
    }
    fn feed(&mut self, bytes: &[u8]) -> bool {
        self.usage.bytes = self.usage.bytes.saturating_add(bytes.len());
        if self.usage.bytes > self.max_bytes || self.usage.bytes > MAX_DECODED_BYTES / 4 {
            self.rejected = true;
            return false;
        }
        for &byte in bytes {
            if self.string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.string = false;
                }
                continue;
            }
            match byte {
                b'"' => {
                    self.usage.nodes += 1;
                    self.string = true;
                    self.primitive = false;
                }
                b'{' | b'[' => {
                    self.usage.nodes += 1;
                    self.depth += 1;
                    self.primitive = false;
                }
                b'}' | b']' => {
                    self.depth = self.depth.saturating_sub(1);
                    self.primitive = false;
                }
                b',' | b':' | b' ' | b'\t' | b'\r' | b'\n' => {
                    self.primitive = false;
                }
                _ if !self.primitive => {
                    self.usage.nodes += 1;
                    self.primitive = true;
                }
                _ => {}
            }
            if self.usage.nodes > MAX_NODES
                || self.depth > MAX_DEPTH
                || self.usage.reservation() > MAX_DECODED_BYTES
            {
                self.rejected = true;
                return false;
            }
        }
        true
    }
}
impl std::io::Write for Scanner {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.feed(bytes) {
            Ok(bytes.len())
        } else {
            Err(std::io::Error::other("JSON resource budget exceeded"))
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// A resource scan, not a JSON validator. The parser still validates syntax.
pub fn usage(bytes: &[u8], max_bytes: usize) -> Option<Usage> {
    let mut scan = Scanner::new(max_bytes);
    scan.feed(bytes).then_some(scan.usage)
}
pub fn within_budget(bytes: &[u8], max_bytes: usize) -> bool {
    usage(bytes, max_bytes).is_some()
}
/// Counts known projection nodes and bytes without copying its serialized JSON.
/// None means resource refusal; serializer failures remain errors.
pub fn encoded_usage<T: serde::Serialize + ?Sized>(
    value: &T,
    max_bytes: usize,
) -> Result<Option<Usage>, serde_json::Error> {
    let mut scan = Scanner::new(max_bytes);
    match serde_json::to_writer(&mut scan, value) {
        Ok(()) => Ok(Some(scan.usage)),
        Err(_) if scan.rejected => Ok(None),
        Err(error) => Err(error),
    }
}
/// Counts the actual serialized representation without allocating a JSON copy.
pub fn encoded_size<T: serde::Serialize + ?Sized>(value: &T) -> Result<usize, serde_json::Error> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("encoded size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Counter(0);
    serde_json::to_writer(&mut count, value)?;
    Ok(count.0)
}
