use extract_choice::pick;

#[test]
fn contract() {
    let left = String::from("abc");
    let right = String::from("fallback");
    assert!(std::ptr::eq(pick(&left, &right, 3), left.as_str()));
    assert!(std::ptr::eq(pick(&left, &right, 4), right.as_str()));
}
