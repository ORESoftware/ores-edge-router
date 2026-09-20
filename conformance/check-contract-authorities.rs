#![forbid(unsafe_code)]
use std::{fs, process::ExitCode};

fn main() -> ExitCode {
    let tsp = fs::read_to_string("contracts/typespec/router-config.tsp").unwrap_or_default();
    let schema = fs::read_to_string("schemas/router.config.schema.json").unwrap_or_default();
    let mut errors = Vec::new();

    for field in ["org", "domain", "hosts", "statusAccess", "primary", "fallback", "access", "websocket"] {
        if !tsp.contains(field) || !schema.contains(&format!("\"{field}\"")) {
            errors.push(format!("TypeSpec/JSON Schema field drift: {field}"));
        }
    }
    for value in ["public", "cloudflare-access", "deny", "k8s", "cloudrun", "cdn", "github", "pages", "tunnel", "other", "proxy", "redirect", "unavailable"] {
        if !tsp.contains(value) || !schema.contains(&format!("\"{value}\"")) {
            errors.push(format!("TypeSpec/JSON Schema enum drift: {value}"));
        }
    }
    if !schema.contains("https://json-schema.org/draft/2020-12/schema") {
        errors.push("router schema must remain Draft 2020-12".into());
    }
    if !schema.contains("\"required\": [\"org\", \"domain\", \"hosts\"]") {
        errors.push("JSON Schema required-field authority drift".into());
    }
    if !tsp.contains("model RouterConfig") || !tsp.contains("model HostRoute") || !tsp.contains("model Origin") {
        errors.push("TypeSpec authority is incomplete".into());
    }

    if errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        for error in errors { eprintln!("conformance error: {error}"); }
        ExitCode::FAILURE
    }
}
