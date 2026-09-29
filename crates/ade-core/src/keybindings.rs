//! Keybinding rules the daemon applies to `settings.set` (F015): what counts
//! as an Electron accelerator, and when two commands share a key.
//!
//! An accelerator is modifiers and one key joined by `+`, as Electron's
//! `Accelerator` documents: <https://www.electronjs.org/docs/latest/api/accelerator>.
//! Modifier and key names are matched without regard to case, as Electron
//! matches them.
use crate::contract::settings::{AppCommand, Keybindings};
use std::collections::BTreeSet;

/// The longest accelerator accepted, in bytes.
pub const MAX_LEN: usize = 64;

/// Modifier names and the modifier each one means.
const MODIFIERS: [(&str, Modifier); 12] = [
    ("command", Modifier::Command),
    ("cmd", Modifier::Command),
    ("control", Modifier::Control),
    ("ctrl", Modifier::Control),
    ("commandorcontrol", Modifier::CommandOrControl),
    ("cmdorctrl", Modifier::CommandOrControl),
    ("alt", Modifier::Alt),
    ("option", Modifier::Alt),
    ("altgr", Modifier::AltGr),
    ("shift", Modifier::Shift),
    ("super", Modifier::Super),
    ("meta", Modifier::Super),
];

/// Named keys besides the function keys and single characters.
const NAMED_KEYS: [&str; 44] = [
    "plus",
    "space",
    "tab",
    "capslock",
    "numlock",
    "scrolllock",
    "backspace",
    "delete",
    "insert",
    "return",
    "enter",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "escape",
    "esc",
    "volumeup",
    "volumedown",
    "volumemute",
    "medianexttrack",
    "mediaprevioustrack",
    "mediastop",
    "mediaplaypause",
    "printscreen",
    "num0",
    "num1",
    "num2",
    "num3",
    "num4",
    "num5",
    "num6",
    "num7",
    "num8",
    "num9",
    "numdec",
    "numadd",
    "numsub",
    "nummult",
    "numdiv",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Modifier {
    Command,
    Control,
    CommandOrControl,
    Alt,
    AltGr,
    Shift,
    Super,
}

/// An accelerator read into its modifiers and key.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Parsed {
    modifiers: BTreeSet<Modifier>,
    /// The key, lower-cased; `return` reads as `enter` and `esc` as `escape`.
    key: String,
}

fn modifier(name: &str) -> Option<Modifier> {
    let name = name.to_ascii_lowercase();
    MODIFIERS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, modifier)| *modifier)
}

fn key(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let single = name.len() == 1 && name.bytes().all(|byte| byte.is_ascii_graphic());
    let function = lower
        .strip_prefix('f')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (1..=24).contains(&number) && !lower.starts_with("f0"));
    (single || function || NAMED_KEYS.contains(&lower.as_str())).then(|| match lower.as_str() {
        "return" => "enter".into(),
        "esc" => "escape".into(),
        _ => lower,
    })
}

fn parse(accelerator: &str) -> Result<Parsed, String> {
    if accelerator.is_empty() || accelerator.len() > MAX_LEN {
        return Err(format!("it must be 1 to {MAX_LEN} characters"));
    }
    if !accelerator.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("it may hold only printable ASCII characters without spaces".into());
    }
    let parts: Vec<&str> = accelerator.split('+').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(
            "each part between + signs must name something; write Plus for the + key".into(),
        );
    }
    let (last, modifiers) = parts.split_last().expect("split yields one part");
    let mut seen = BTreeSet::new();
    for name in modifiers {
        let modifier = modifier(name).ok_or_else(|| format!("{name} is not a modifier"))?;
        if !seen.insert(modifier) {
            return Err(format!("{name} is repeated"));
        }
    }
    if modifier(last).is_some() {
        return Err("it must end with a key, not a modifier".into());
    }
    let key = key(last).ok_or_else(|| format!("{last} is not a key"))?;
    Ok(Parsed {
        modifiers: seen,
        key,
    })
}

/// Checks that `accelerator` is an Electron accelerator, and says why not.
pub fn validate(accelerator: &str) -> Result<(), String> {
    parse(accelerator).map(|_| ())
}

/// The keys `parsed` presses on macOS and on other systems, where
/// `CommandOrControl` means Command and Control respectively.
fn pressed(parsed: &Parsed) -> [(BTreeSet<Modifier>, &str); 2] {
    let on = |platform: Modifier| {
        let modifiers = parsed
            .modifiers
            .iter()
            .map(|modifier| match modifier {
                Modifier::CommandOrControl => platform,
                other => *other,
            })
            .collect();
        (modifiers, parsed.key.as_str())
    };
    [on(Modifier::Command), on(Modifier::Control)]
}

/// The first key two commands share, on either platform, and those commands.
/// `CmdOrCtrl+N` shares a key with `Cmd+N` and with `Ctrl+N`. Every bound key
/// must already be valid.
pub fn conflict(keys: &Keybindings) -> Option<(String, Vec<AppCommand>)> {
    let bound: Vec<(AppCommand, &str, Parsed)> = AppCommand::ALL
        .into_iter()
        .filter_map(|command| {
            let key = keys.get(command)?;
            Some((command, key, parse(key).ok()?))
        })
        .collect();
    for (index, (command, key, parsed)) in bound.iter().enumerate() {
        let sharing: Vec<AppCommand> = bound[index + 1..]
            .iter()
            .filter(|(_, _, other)| {
                pressed(parsed)
                    .iter()
                    .zip(pressed(other).iter())
                    .any(|(mine, theirs)| mine == theirs)
            })
            .map(|(other, _, _)| *other)
            .collect();
        if !sharing.is_empty() {
            return Some((
                (*key).to_owned(),
                std::iter::once(*command).chain(sharing).collect(),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_modifiers_and_one_key() {
        for good in [
            "CmdOrCtrl+N",
            "Ctrl+Shift+`",
            "CmdOrCtrl+\\",
            "CmdOrCtrl+,",
            "commandorcontrol+shift+p",
            "Alt+F4",
            "F12",
            "Shift+Plus",
            "Super+Space",
            "Option+Return",
            "CmdOrCtrl+Alt+B",
        ] {
            assert!(validate(good).is_ok(), "{good}: {:?}", validate(good));
        }
        for bad in [
            "",
            "Ctrl+",
            "Ctrl++",
            "+A",
            "Ctrl",
            "Ctrl+Shift",
            "Hyper+A",
            "Ctrl+Ctrl+A",
            "Cmd+Command+A",
            "Ctrl+AB",
            "Ctrl+F0",
            "Ctrl+F25",
            "Ctrl+F01",
            "Ctrl+ A",
            "Ctrl+\u{e9}",
            "Ctrl+\n",
        ] {
            assert!(validate(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(validate(&format!("Ctrl+{}", "Shift+".repeat(20))).is_err());
    }

    #[test]
    fn the_defaults_are_valid_and_share_no_key() {
        let defaults = Keybindings::default();
        for command in AppCommand::ALL {
            validate(defaults.get(command).unwrap()).unwrap();
        }
        assert_eq!(conflict(&defaults), None);
    }

    #[test]
    fn a_key_is_shared_across_names_order_case_and_platforms() {
        let mut keys = Keybindings::default();
        keys.set(AppCommand::NewTab, Some("shift+ctrl+`".into()));
        assert_eq!(
            conflict(&keys),
            Some((
                "shift+ctrl+`".into(),
                vec![AppCommand::NewTab, AppCommand::NewTerminal]
            ))
        );
        // CmdOrCtrl+N is Command+N on macOS.
        let mut keys = Keybindings::default();
        keys.set(AppCommand::CloseTab, Some("Cmd+N".into()));
        assert_eq!(
            conflict(&keys).map(|(_, commands)| commands),
            Some(vec![AppCommand::NewConversation, AppCommand::CloseTab])
        );
        // Return and Enter are one key; an unbound command shares nothing.
        let mut keys = Keybindings::default();
        keys.set(AppCommand::NewTab, Some("Alt+Return".into()));
        keys.set(AppCommand::CloseTab, Some("alt+enter".into()));
        keys.set(AppCommand::NewConversation, None);
        assert!(conflict(&keys).is_some());
        keys.set(AppCommand::CloseTab, None);
        assert_eq!(conflict(&keys), None);
    }
}
