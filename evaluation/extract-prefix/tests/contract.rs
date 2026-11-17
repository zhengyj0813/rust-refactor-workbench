use extract_prefix::pick;

#[test]
fn contract() {
    let input = String::from("é:ok");
    let found = {
        let prefix = String::from("é:");
        pick(&input, &prefix)
    };
    assert_eq!(found, Some("ok"));
    assert_eq!(pick("x", "x"), None);
    assert_eq!(pick("abc", "z"), None);
}
