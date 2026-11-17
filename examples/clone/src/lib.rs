fn checksum(bytes: Vec<u8>) -> u64 {
    bytes.iter().map(|&value| u64::from(value)).sum()
}

pub fn total(bytes: &Vec<u8>) -> u64 {
    checksum(bytes.clone())
}

#[test]
fn totals_empty_and_nonempty_input() {
    assert_eq!(total(&vec![]), 0);
    assert_eq!(total(&vec![0, 4, 255]), 259);
}
