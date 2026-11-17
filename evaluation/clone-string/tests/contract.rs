use clone_string::measure;

#[test]
fn contract() {
    assert_eq!(measure(&String::new()), 0);
    assert_eq!(measure(&String::from("aé🙂")), 3);
}
