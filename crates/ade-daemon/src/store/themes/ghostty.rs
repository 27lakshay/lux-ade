use super::*;

impl Store {
    pub fn export_ghostty_theme(
        &self,
        request: &GhosttyThemeExportRequest,
    ) -> Result<GhosttyThemeExport> {
        let exported = self.export_theme(&ThemeExportRequest {
            id: request.id.clone(),
            expected_revision: Some(request.expected_revision),
        })?;
        let definition = validate(&exported.source).definition.context(
            "The stored theme definition is invalid and cannot be exported as Ghostty colors",
        )?;
        let terminal = definition
            .terminal
            .as_ref()
            .context("This definition has no terminal colors to export")?;
        let mut omissions = Vec::new();
        let mut omit = |path: String, reason: &str| {
            omissions.push(GhosttyExportOmission {
                path,
                reason: reason.into(),
            })
        };
        let name: String = definition
            .name
            .chars()
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect();
        let mut source = format!(
            "# ADE Ghostty color export v1\n# Theme: {} ({})\n# Definition revision: {}\npalette-generate = false\npalette-harmonious = false\n",
            name, definition.id, exported.theme.revision
        );
        for (key, role) in [
            ("foreground", "terminal-foreground"),
            ("background", "terminal"),
            ("cursor-color", "terminal-cursor"),
            ("cursor-text", "terminal-cursor-text"),
            ("selection-foreground", "terminal-selection-foreground"),
            ("selection-background", "terminal-selection"),
        ] {
            let value = &terminal.tokens[role];
            if value.starts_with('#') && value.len() == 9 && !value.ends_with("ff") {
                omit(
                    format!("/terminal/tokens/{role}"),
                    "Ghostty theme colors do not represent ADE's eight-bit selection alpha. The selection background assignment is omitted.",
                );
            } else {
                let value = if value.len() == 9 { &value[..7] } else { value };
                source.push_str(&format!("{key} = {value}\n"));
            }
        }
        for index in 0..256 {
            source.push_str(&format!(
                "palette = {index}={}\n",
                terminal.tokens[&format!("terminal-ansi-{index}")]
            ));
        }
        if definition.app.is_some() {
            omit(
                "/app".into(),
                "Ghostty theme files do not represent ADE app colors.",
            );
        }
        if definition.syntax.is_some() {
            omit(
                "/syntax".into(),
                "Ghostty theme files do not represent ADE syntax colors.",
            );
        }
        if definition.pack.is_some() {
            omit(
                "/pack".into(),
                "Ghostty color files do not represent ADE pack identity.",
            );
        }
        omit(
            "/provenance".into(),
            "Source attribution remains in the ADE export report; Ghostty color assignments do not encode ADE provenance.",
        );
        omit(
            "/appearance".into(),
            "Profile preferences, contrast, bold color, typography, cursor behavior, per-terminal bindings and live OSC overrides are separate from definition colors and are not exported.",
        );
        for (path, extensions) in [
            ("", &definition.extensions),
            ("/terminal", &terminal.extensions),
        ] {
            for key in extensions.keys() {
                omit(
                    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                    "Retained extension data is not emitted as Ghostty configuration.",
                );
            }
        }
        for role in terminal.tokens.keys() {
            if !matches!(
                role.as_str(),
                "terminal"
                    | "terminal-foreground"
                    | "terminal-cursor"
                    | "terminal-cursor-text"
                    | "terminal-selection-foreground"
                    | "terminal-selection"
            ) && !role.strip_prefix("terminal-ansi-").is_some_and(|index| {
                index
                    .parse::<u8>()
                    .is_ok_and(|value| value.to_string() == index)
            }) {
                omit(
                    format!("/terminal/tokens/{role}"),
                    "This ADE token has no supported Ghostty color assignment.",
                );
            }
        }
        Ok(GhosttyThemeExport {
            tag: Default::default(),
            theme: exported.theme,
            source,
            omissions,
        })
    }
}
