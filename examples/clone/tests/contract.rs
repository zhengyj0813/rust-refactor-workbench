use clone_example::total;

#[test]
fn checksum_contract() {
    let input = vec![255, 0, 1, 2, 255];
    assert_eq!(total(&input), 513);
    assert_eq!(total(&Vec::new()), 0);
}
