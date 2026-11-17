use formal_choice::pick;

#[test]
fn covers_each_branch_away_from_the_boundary() {
    assert_eq!(pick("abc", "right", 2), "abc");
    assert_eq!(pick("abc", "right", 4), "right");
}
