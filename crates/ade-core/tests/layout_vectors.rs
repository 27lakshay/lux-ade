//! The shared layout vectors: `{name, before, action, after}` steps that the
//! desktop's TS reducer (`layout.logic.ts`) produced, run through the Rust
//! core. Each file in `layout-vectors/` is one area of the TS example tests;
//! `random.json` is seeded random walks over the property test's action mix.
use ade_core::contract::layout::{Layout, LayoutAction};
use ade_core::layout::{apply, check};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

#[derive(Deserialize)]
struct Vector {
    name: String,
    before: Layout,
    action: LayoutAction,
    after: Value,
}

/// Equal as JSON, with numbers equal to within rounding of the last bit.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            (a - b).abs() <= 1e-9 * a.abs().max(1.0)
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| same(x, y)))
        }
        _ => left == right,
    }
}

#[test]
fn the_rust_core_matches_every_ts_vector() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/layout-vectors");
    let mut files: Vec<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(files.len() >= 5, "the vector files are missing");
    let mut count = 0;
    for file in files {
        let vectors: Vec<Vector> =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        for vector in vectors {
            let label = format!("{}: {}", file.file_name().unwrap().display(), vector.name);
            check(&vector.before).unwrap_or_else(|error| panic!("{label}: before: {error}"));
            let after = apply(&vector.before, &vector.action)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
            let actual = serde_json::to_value(&after).unwrap();
            assert!(
                same(&actual, &vector.after),
                "{label}\nexpected {}\nactual   {}",
                vector.after,
                actual
            );
            check(&after).unwrap_or_else(|error| panic!("{label}: after: {error}"));
            count += 1;
        }
    }
    assert!(count > 100, "only {count} vectors ran");
}
