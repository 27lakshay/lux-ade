//! Print the ADE contract bundle as JSON Schema. `pnpm contract:generate` reads it.
fn main() {
    let bundle = ade_core::contract::bundle();
    println!(
        "{}",
        serde_json::to_string_pretty(&bundle).expect("contract bundle serializes")
    );
}
