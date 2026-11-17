use local_extract::compute;

#[test]
fn preserves_normal_and_saturated_results() {
    assert_eq!(compute(0), 1);
    assert_eq!(compute(10), 11);
    assert_eq!(compute(u32::MAX), u32::MAX);
}
