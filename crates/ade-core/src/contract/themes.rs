//! Profile theme library. Queries return data; desired-state mutations are idempotent commands.
use super::{FrameSpec, OperationSpec, Tier};
use crate::appearance::{
    PaletteMode,
    definition::{ThemeDefinition, ThemeDiagnostic, ThemeProvenance, ThemeValidation},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<GhosttyThemeExportRequest, GhosttyThemeExport>(
            "themes.ghostty.export",
            Tier::Query,
        ),
        OperationSpec::new::<GhosttyThemeValidateRequest, GhosttyThemeValidation>(
            "themes.ghostty.validate",
            Tier::Query,
        ),
        OperationSpec::new::<WarpThemeValidateRequest, WarpThemeValidation>(
            "themes.warp.validate",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeFileValidateRequest, ThemeFileValidation>(
            "themes.file.validate",
            Tier::Query,
        ),
        OperationSpec::new::<ThemePackExportRequest, ThemePackExport>(
            "themes.pack.export",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeValidateRequest, ThemeValidationResponse>(
            "themes.validate",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeListRequest, ThemeLibrary>("themes.list", Tier::Query),
        OperationSpec::new::<ThemeInspectRequest, ThemeInspectResponse>(
            "themes.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeInstallRequest, ThemeInstallation>(
            "themes.install",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ThemeRenameRequest, ThemeInstallation>(
            "themes.rename",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ThemeExportRequest, ThemeExport>("themes.export", Tier::Query),
        OperationSpec::new::<ThemePreviewRequest, ThemePreview>("themes.preview", Tier::Query),
        OperationSpec::new::<ThemeDraftPreviewRequest, ThemeDraftPreview>(
            "themes.draft.preview",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeRemovalPlanRequest, ThemeRemovalPlan>(
            "themes.removal",
            Tier::Query,
        ),
        OperationSpec::new::<ThemeRemoveRequest, ThemeRemoval>(
            "themes.remove",
            Tier::IdempotentCommand,
        ),
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyThemeExportRequest {
    pub id: String,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyExportOmission {
    pub path: String,
    pub reason: String,
}
wire_tag!(GhosttyThemeExportTag, "ghostty_theme_export");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyThemeExport {
    #[serde(rename = "type")]
    pub tag: GhosttyThemeExportTag,
    pub theme: ThemeSummary,
    pub source: String,
    pub omissions: Vec<GhosttyExportOmission>,
}

/// Theme text with inert optional setting proposals. Source names never cause filesystem access.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyThemeValidateRequest {
    pub source: String,
    pub id: String,
    pub name: String,
    pub mode: PaletteMode,
    pub source_name: Option<String>,
}
wire_tag!(GhosttyThemeValidationTag, "ghostty_theme_validation");
/// Independently accepted profile settings, never part of an installed color definition.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyAppearancePolicies {
    #[schemars(with = "Option<serde_json::Number>", range(min = 1.0, max = 21.0))]
    pub minimum_contrast: Option<f64>,
    pub bold_color: Option<crate::appearance::BoldColor>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GhosttyThemeValidation {
    #[serde(rename = "type")]
    pub tag: GhosttyThemeValidationTag,
    /// Canonical ADE source for explicit review and the ordinary revision-checked installation.
    pub source: Option<String>,
    /// Resolved candidate colors for an isolated local renderer; never applied to real terminals.
    pub preview: Option<crate::appearance::TerminalAppearance>,
    pub policies: GhosttyAppearancePolicies,
    pub validation: ThemeValidationResponse,
}

/// Warp YAML becomes a standard ADE terminal definition after preview.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WarpThemeValidateRequest {
    pub source: String,
    pub id: String,
    pub source_name: Option<String>,
}
wire_tag!(WarpThemeValidationTag, "warp_theme_validation");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WarpThemeValidation {
    #[serde(rename = "type")]
    pub tag: WarpThemeValidationTag,
    pub source: Option<String>,
    pub preview: Option<crate::appearance::TerminalAppearance>,
    pub validation: ThemeValidationResponse,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeFileValidateRequest {
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeFileCandidate {
    /// Accepted definition data; pack identity is materialized without selecting the member.
    pub source: String,
    pub validation: ThemeValidationResponse,
}
wire_tag!(ThemeFileValidationTag, "theme_file_validation");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeFileValidation {
    #[serde(rename = "type")]
    pub tag: ThemeFileValidationTag,
    pub pack: Option<crate::appearance::pack::ThemePackIdentity>,
    /// False for invalid/unsupported pack headers, ambiguous structure or bounded-source failures.
    pub container_valid: bool,
    pub diagnostics: Vec<ThemeDiagnostic>,
    /// Valid members may be explicitly accepted even when another member has a required color error.
    pub candidates: Vec<ThemeFileCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePackExportItem {
    pub id: String,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePackExportRequest {
    pub id: String,
    pub name: String,
    pub items: Vec<ThemePackExportItem>,
}
wire_tag!(ThemePackExportTag, "theme_pack_export");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePackExport {
    #[serde(rename = "type")]
    pub tag: ThemePackExportTag,
    pub pack: crate::appearance::pack::ThemePackIdentity,
    pub themes: Vec<ThemeSummary>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRemovalPlanRequest {
    pub id: String,
    /// Exclusive impact key. Pages contain at most 16 affected selections.
    pub after_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThemeConsumer {
    App,
    Terminal,
    Syntax,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThemeSelectionSlot {
    Light,
    Dark,
    Fixed,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRemovalImpact {
    pub key: String,
    pub consumer: ThemeConsumer,
    pub slot: ThemeSelectionSlot,
    pub workspace_id: Option<String>,
    pub terminal_id: Option<String>,
    /// Follow-app references change through their app slot; their binding remains follow-app.
    pub indirect: bool,
    pub fallback_id: String,
}
wire_tag!(ThemeRemovalPlanTag, "theme_removal_plan");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRemovalPlan {
    #[serde(rename = "type")]
    pub tag: ThemeRemovalPlanTag,
    pub theme: ThemeSummary,
    pub removable: bool,
    pub appearance_revision: u64,
    pub total: usize,
    pub impacts: Vec<ThemeRemovalImpact>,
    pub next_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRemoveRequest {
    pub id: String,
    pub expected_revision: u64,
    pub expected_appearance_revision: u64,
}
wire_tag!(ThemeRemovalTag, "theme_removal");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRemoval {
    #[serde(rename = "type")]
    pub tag: ThemeRemovalTag,
    pub id: String,
    pub changed: bool,
    pub revision: u64,
    pub appearance_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePreviewRequest {
    pub app_light_theme: String,
    pub app_dark_theme: String,
    pub terminal_binding: crate::appearance::ThemeBinding,
    pub syntax_binding: crate::appearance::ThemeBinding,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePreviewSample {
    pub app: crate::appearance::BuiltinPalette,
    pub syntax: crate::appearance::BuiltinPalette,
    pub terminal: crate::appearance::TerminalAppearance,
    pub terminal_name: String,
    pub diagnostics: Vec<super::settings::AppearanceDiagnostic>,
}
wire_tag!(ThemePreviewTag, "theme_preview");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemePreview {
    #[serde(rename = "type")]
    pub tag: ThemePreviewTag,
    pub appearance_revision: u64,
    pub expected_theme_revisions: std::collections::BTreeMap<String, u64>,
    pub samples: Vec<ThemePreviewSample>,
}

/// Resolves an unsaved definition for editor rendering without installing or applying it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeDraftPreviewRequest {
    pub source: String,
}
wire_tag!(ThemeDraftPreviewTag, "theme_draft_preview");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeDraftPreview {
    #[serde(rename = "type")]
    pub tag: ThemeDraftPreviewTag,
    pub definition: ThemeDefinition,
    /// Declared app projection for role inspection, absent for terminal-only themes.
    pub app: Option<crate::appearance::BuiltinPalette>,
    /// Declared terminal projection for role inspection, absent for other themes.
    pub terminal: Option<crate::appearance::TerminalAppearance>,
    /// Declared syntax projection for role inspection, absent for other themes.
    pub syntax: Option<crate::appearance::BuiltinPalette>,
    pub light: ThemePreviewSample,
    pub dark: ThemePreviewSample,
    pub valid: bool,
    pub diagnostics: Vec<ThemeDiagnostic>,
}
pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<ThemeLibraryChanged>(
        "theme_library_changed",
    )]
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeValidateRequest {
    pub source: String,
}
wire_tag!(ThemeValidationTag, "theme_validation");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeValidationResponse {
    #[serde(rename = "type")]
    pub tag: ThemeValidationTag,
    #[serde(flatten)]
    pub validation: ThemeValidation,
    /// Existing stable ID at validation time, for explicit revision-checked replacement.
    pub target: Option<ThemeSummary>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ThemeListRequest {
    /// Exclusive stable ID cursor. Pages contain at most 16 summaries.
    pub after_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInspectRequest {
    pub id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeSections {
    pub app: bool,
    pub terminal: bool,
    pub syntax: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeSummary {
    pub id: String,
    pub name: String,
    pub mode: PaletteMode,
    /// A record revision is the library revision at which its definition last changed.
    /// Bundled definitions use revision 0 and are immutable.
    pub revision: u64,
    pub bundled: bool,
    pub sections: ThemeSections,
    pub provenance: ThemeProvenance,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRecord {
    pub revision: u64,
    pub definition: ThemeDefinition,
    /// Accepted source is retained independently of the original file.
    pub source: String,
    pub diagnostics: Vec<ThemeDiagnostic>,
}
impl ThemeRecord {
    pub fn summary(&self) -> ThemeSummary {
        ThemeSummary {
            id: self.definition.id.clone(),
            name: self.definition.name.clone(),
            mode: self.definition.mode,
            revision: self.revision,
            bundled: matches!(
                self.definition.provenance.kind,
                crate::appearance::definition::ThemeOrigin::Bundled
            ),
            sections: ThemeSections {
                app: self.definition.app.is_some(),
                terminal: self.definition.terminal.is_some(),
                syntax: self.definition.syntax.is_some(),
            },
            provenance: self.definition.provenance.clone(),
        }
    }
}
wire_tag!(ThemeLibraryTag, "theme_library");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeLibrary {
    #[serde(rename = "type")]
    pub tag: ThemeLibraryTag,
    pub revision: u64,
    pub themes: Vec<ThemeSummary>,
    pub next_id: Option<String>,
}
wire_tag!(ThemeRecordTag, "theme_record");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInspectResponse {
    #[serde(rename = "type")]
    pub tag: ThemeRecordTag,
    pub theme: ThemeRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInstallItem {
    pub source: String,
    /// Zero creates an absent ID. A replacement names the currently inspected revision.
    /// Repeating already-committed identical normalized content returns its current record unchanged.
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInstallRequest {
    /// Only the explicitly accepted definitions belong here. The entire set validates before mutation.
    pub items: Vec<ThemeInstallItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInstallReport {
    pub index: usize,
    pub valid: bool,
    pub diagnostics: Vec<ThemeDiagnostic>,
    pub theme: Option<ThemeSummary>,
}
wire_tag!(ThemeInstallationTag, "theme_installation");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeInstallation {
    #[serde(rename = "type")]
    pub tag: ThemeInstallationTag,
    pub committed: bool,
    pub changed: bool,
    pub revision: u64,
    pub items: Vec<ThemeInstallReport>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeRenameRequest {
    pub id: String,
    pub name: String,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeExportRequest {
    pub id: String,
    pub expected_revision: Option<u64>,
}
wire_tag!(ThemeExportTag, "theme_export");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeExport {
    #[serde(rename = "type")]
    pub tag: ThemeExportTag,
    pub theme: ThemeSummary,
    pub source: String,
}
wire_tag!(ThemeLibraryChangedTag, "theme_library_changed");
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeLibraryChanged {
    #[serde(rename = "type")]
    pub tag: ThemeLibraryChangedTag,
    /// Feed ordering is independent of durable theme library revisions.
    pub revision: u64,
    pub boot_id: String,
    pub library_revision: u64,
    pub changed_ids: Vec<String>,
}
