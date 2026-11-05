use std::time::{Duration, Instant};

pub struct Packet {
    pub sequence: u16,
    pub timestamp: u32,
    pub bytes: Vec<u8>,
    received: Instant,
}
// In-order audio passes immediately. Only a real gap gets a bounded 20 ms
// reorder window, shorter than the existing playback prebuffer. Never replay
// duplicates or let a missing packet accumulate an unbounded queue.
#[derive(Default)]
pub struct AudioQueue {
    next: Option<u16>,
    pending: Vec<Packet>,
}
impl AudioQueue {
    pub fn push(&mut self, sequence: u16, timestamp: u32, bytes: &[u8], now: Instant) {
        if bytes.is_empty() || bytes.len() > 8192 {
            return;
        }
        let next = *self.next.get_or_insert(sequence);
        let distance = sequence.wrapping_sub(next) as i16;
        if distance < 0 || self.pending.iter().any(|p| p.sequence == sequence) {
            return;
        }
        if distance > 256 || self.pending.len() >= 24 {
            self.pending.clear();
            self.next = Some(sequence);
        }
        self.pending.push(Packet {
            sequence,
            timestamp,
            bytes: bytes.to_vec(),
            received: now,
        });
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.pending
            .iter()
            .map(|p| p.received + Duration::from_millis(20))
            .min()
    }
    pub fn drain(&mut self, now: Instant) -> Vec<Packet> {
        let mut output = Vec::new();
        while let Some(next) = self.next {
            let Some(index) = self
                .pending
                .iter()
                .enumerate()
                .min_by_key(|(_, p)| p.sequence.wrapping_sub(next))
                .map(|(i, _)| i)
            else {
                break;
            };
            if self.pending[index].sequence != next && self.deadline().is_none_or(|at| now < at) {
                break;
            }
            let packet = self.pending.remove(index);
            self.next = Some(packet.sequence.wrapping_add(1));
            output.push(packet);
        }
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordering_duplicates_wrap_and_loss() {
        let now = Instant::now();
        let mut q = AudioQueue::default();
        q.push(65535, 100, &[1], now);
        assert_eq!(q.drain(now).len(), 1);
        q.push(1, 1060, &[3], now);
        assert!(q.drain(now).is_empty());
        q.push(0, 580, &[2], now);
        q.push(1, 1060, &[3], now);
        assert_eq!(
            q.drain(now).iter().map(|p| p.sequence).collect::<Vec<_>>(),
            vec![0, 1]
        );
        q.push(0, 580, &[2], now);
        assert!(q.drain(now).is_empty());
        q.push(3, 2020, &[5], now);
        assert!(q.drain(now).is_empty());
        assert_eq!(q.drain(now + Duration::from_millis(20))[0].sequence, 3);
        q.push(2, 1540, &[4], now);
        assert!(q.drain(now).is_empty());
    }
    #[test]
    fn bounded_under_large_gaps_and_floods() {
        let now = Instant::now();
        let mut q = AudioQueue::default();
        q.push(0, 0, &[1], now);
        q.drain(now);
        for i in 2..10000 {
            q.push(i, u32::from(i) * 480, &[1], now);
            assert!(q.pending.len() <= 24);
        }
        assert!(!q.drain(now + Duration::from_millis(20)).is_empty());
    }
}
