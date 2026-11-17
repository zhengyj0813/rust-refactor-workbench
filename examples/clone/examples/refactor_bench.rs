use clone_example::total;
use std::hint::black_box;
use std::time::Instant;

fn main() {
    let rows: Vec<_> = [64, 4096, 1048576]
        .into_iter()
        .map(|size| {
            let bytes = (0..size).map(|index| (index % 251) as u8).collect();
            let checksum = total(&bytes);
            let iterations = (1048576 / size).max(8);
            let samples: Vec<_> = (0..7)
                .map(|_| {
                    let start = Instant::now();
                    for _ in 0..iterations {
                        black_box(total(black_box(&bytes)));
                    }
                    start.elapsed().as_nanos()
                })
                .collect();
            format!(
                "{{\"bytes\":{size},\"checksum\":{checksum},\"samples_ns\":{samples:?}}}"
            )
        })
        .collect();
    println!("[{}]", rows.join(","));
}
