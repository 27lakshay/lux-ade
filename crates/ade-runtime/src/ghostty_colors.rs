//! Color parsing from the same pinned native library that answers terminal queries.
use ade_core::appearance::Rgb;

#[cfg(feature = "native-terminal")]
unsafe extern "C" {
    fn ghostty_color_parse(value: *const u8, len: usize, out: *mut Rgb) -> i32;
    fn ghostty_color_parse_palette_entry(
        value: *const u8,
        len: usize,
        index: *mut u8,
        out: *mut Rgb,
    ) -> i32;
    fn ghostty_color_palette_default(out: *mut Rgb);
}

/// A build without native terminal support cannot claim Ghostty compatibility.
pub fn default_palette() -> Option<Vec<Rgb>> {
    #[cfg(feature = "native-terminal")]
    {
        let mut colors = vec![Rgb { r: 0, g: 0, b: 0 }; 256];
        // The pinned ABI writes exactly 256 repr(C) RGB structs.
        unsafe { ghostty_color_palette_default(colors.as_mut_ptr()) };
        Some(colors)
    }
    #[cfg(not(feature = "native-terminal"))]
    {
        None
    }
}

pub fn parse(value: &str) -> Option<Rgb> {
    #[cfg(feature = "native-terminal")]
    {
        let mut rgb = Rgb { r: 0, g: 0, b: 0 };
        // Ghostty reads the supplied byte slice synchronously and retains no pointers.
        (unsafe { ghostty_color_parse(value.as_ptr(), value.len(), &mut rgb) } == 0).then_some(rgb)
    }
    #[cfg(not(feature = "native-terminal"))]
    {
        let _ = value;
        None
    }
}

pub fn parse_palette_entry(value: &str) -> Option<(u8, Rgb)> {
    #[cfg(feature = "native-terminal")]
    {
        let mut index = 0;
        let mut rgb = Rgb { r: 0, g: 0, b: 0 };
        // Both outputs have the size and alignment declared by the pinned C ABI.
        (unsafe {
            ghostty_color_parse_palette_entry(value.as_ptr(), value.len(), &mut index, &mut rgb)
        } == 0)
            .then_some((index, rgb))
    }
    #[cfg(not(feature = "native-terminal"))]
    {
        let _ = value;
        None
    }
}

pub fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../native/dependencies.json"))
                .expect("The tracked native dependency manifest must be valid");
        manifest["sources"]["libghostty-vt"]["subdirectory"]
            .as_str()
            .and_then(|directory| directory.strip_prefix("herdr-"))
            .and_then(|directory| directory.strip_suffix("/vendor/libghostty-vt"))
            .expect("The Ghostty source must identify its pinned commit")
            .to_owned()
    })
}
