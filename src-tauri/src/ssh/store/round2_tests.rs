use super::*;

#[test]
fn ssh_move_final_index_table_preserves_exact_mixed_sibling_order() {
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../src/renderer/components/Settings/__tests__/fixtures/sshMoveCases.json"
    ))
    .unwrap();
    for case in table["cases"].as_array().unwrap() {
        let mut data = Persisted::default();
        let mut counts = std::collections::HashMap::new();
        for row in table["start"].as_array().unwrap() {
            let id = row["id"].as_str().unwrap();
            let parent = row["parentId"].as_str();
            let order = counts.entry(parent).or_insert(0);
            if row["kind"] == "folder" {
                let mut f = folder(id, parent);
                f.order = *order;
                data.folders.push(f);
            } else {
                let mut c = connection(id);
                c.folder_id = parent.map(str::to_owned);
                c.order = *order;
                data.connections.push(c);
            }
            *order += 1;
        }
        let id = case["from"].as_str().unwrap();
        let kind = if data.folders.iter().any(|f| f.id == id) {
            "folder"
        } else {
            "connection"
        };
        data.move_row(
            kind,
            id,
            case["toParent"].as_str().map(str::to_owned),
            case["toIndex"].as_u64().unwrap() as usize,
        )
        .unwrap();
        data.validate().unwrap();
        for (key, parent) in [("root", None), ("f-parent", Some("f-parent"))] {
            let mut rows: Vec<_> = data
                .folders
                .iter()
                .filter(|f| f.parent_id.as_deref() == parent)
                .map(|f| (f.order, f.id.as_str()))
                .chain(
                    data.connections
                        .iter()
                        .filter(|c| c.folder_id.as_deref() == parent)
                        .map(|c| (c.order, c.id.as_str())),
                )
                .collect();
            rows.sort_by_key(|row| row.0);
            assert_eq!(
                serde_json::json!(rows.iter().map(|row| row.1).collect::<Vec<_>>()),
                case["expected"][key],
                "{} / {key}",
                case["name"]
            );
        }
    }
    // Minimal contract pin: index is FINAL, not a pre-removal boundary.
    let mut data = Persisted::default();
    for (order, id) in ["a", "b", "c"].iter().enumerate() {
        let mut row = connection(id);
        row.order = order;
        data.connections.push(row);
    }
    data.move_row("connection", "a", None, 1).unwrap();
    data.connections.sort_by_key(|c| c.order);
    assert_eq!(
        data.connections
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b", "a", "c"]
    );
}

#[test]
fn ssh_read_error_paths_are_prefixed_exactly_once_in_all_public_replies() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.path()).unwrap();
    let store = temp.store();
    let path = temp.path().display().to_string();
    let errors = [
        store.get().unwrap().view.load_error.unwrap(),
        store.reload(|_| {}).unwrap().view.load_error.unwrap(),
        store.transact(|_| Ok(()), |_| panic!()).unwrap_err(),
    ];
    for error in errors {
        assert_eq!(error.message.matches(&path).count(), 1, "{error:?}");
    }
    assert_eq!(store.load().unwrap_err().message.matches(&path).count(), 0);
}
