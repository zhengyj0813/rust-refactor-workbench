use formal_choice::pick;
use std::ptr;

const SEED: u64 = 134_261;

fn next(state: &mut u64) -> usize {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state as usize
}

fn main() {
    let mut state = SEED;
    let cases: Vec<_> = (0..512)
        .map(|index| {
            let left_len = if index == 0 { 1 } else { next(&mut state) % 97 };
            let threshold = match index % 4 {
                0 => left_len,
                1 => left_len.saturating_sub(1),
                2 => left_len + 1,
                _ => next(&mut state) % 98,
            };
            let left = "x".repeat(left_len);
            let right = String::from("fallback");
            let result = pick(&left, &right, threshold);
            let origin = if ptr::eq(result, left.as_str()) {
                "left"
            } else if ptr::eq(result, right.as_str()) {
                "right"
            } else {
                "other"
            };
            format!(
                "{{\"input\":{{\"left_len\":{left_len},\"threshold\":{threshold}}},\"output\":{{\"origin\":\"{origin}\",\"len\":{}}}}}",
                result.len()
            )
        })
        .collect();
    println!("{{\"seed\":{SEED},\"cases\":[{}]}}", cases.join(","));
}
