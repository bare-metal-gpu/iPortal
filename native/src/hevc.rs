// Bounded, low-latency RFC 7798 receiver. The paired tunnel preserves ordering;
// loss or reordering discards the incomplete access unit and requests a keyframe.
const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_PARAMETER_SET: usize = 64 * 1024;
#[derive(Default)]
pub struct Assembler {
    sequence: Option<u16>,
    timestamp: Option<u32>,
    frame: Vec<u8>,
    fragment: Vec<u8>,
    parameters: [Vec<u8>; 3],
    waiting_for_sync: bool,
    sync: bool,
}
pub struct Frame {
    pub bytes: Vec<u8>,
    pub configuration: Vec<u8>,
    pub sync: bool,
}
impl Assembler {
    pub fn new() -> Self {
        Self {
            waiting_for_sync: true,
            ..Self::default()
        }
    }
    pub fn reset(&mut self) {
        self.frame.clear();
        self.fragment.clear();
        self.waiting_for_sync = true;
        self.sync = false;
    }
    fn nal(&mut self, nal: &[u8]) -> Result<(), ()> {
        if nal.len() < 2 || nal[0] & 0x80 != 0 || nal[1] & 7 == 0 {
            return Err(());
        }
        let kind = (nal[0] >> 1) & 63;
        if (32..=34).contains(&kind) {
            if nal.len() > MAX_PARAMETER_SET {
                return Err(());
            }
            let i = (kind - 32) as usize;
            if self.parameters[i] != nal {
                self.parameters[i] = nal.to_vec();
                self.waiting_for_sync = true;
            }
            return Ok(());
        }
        if kind >= 48 {
            return Err(());
        }
        if self.frame.len() + 4 + nal.len() > MAX_FRAME {
            return Err(());
        }
        self.sync |= (16..=23).contains(&kind);
        self.frame
            .extend_from_slice(&(nal.len() as u32).to_be_bytes());
        self.frame.extend_from_slice(nal);
        Ok(())
    }
    pub fn push(
        &mut self,
        seq: u16,
        timestamp: u32,
        marker: bool,
        payload: &[u8],
    ) -> Result<Option<Frame>, ()> {
        let gap = self.sequence.is_some_and(|s| seq != s.wrapping_add(1));
        self.sequence = Some(seq);
        if gap {
            self.reset();
            self.timestamp = Some(timestamp);
            return Err(());
        }
        if self.timestamp.is_some_and(|t| t != timestamp)
            && (!self.frame.is_empty() || !self.fragment.is_empty())
        {
            self.reset();
            self.timestamp = Some(timestamp);
            return Err(());
        }
        self.timestamp = Some(timestamp);
        let result = self.payload(payload);
        if result.is_err() {
            self.reset();
            return Err(());
        }
        if !marker {
            return Ok(None);
        }
        if !self.fragment.is_empty() {
            self.reset();
            return Err(());
        }
        if self.frame.is_empty() {
            return Ok(None);
        }
        let bytes = std::mem::take(&mut self.frame);
        let sync = std::mem::take(&mut self.sync);
        if self.parameters.iter().any(Vec::is_empty) || (self.waiting_for_sync && !sync) {
            return Ok(None);
        }
        let mut configuration = Vec::new();
        if self.waiting_for_sync {
            for p in &self.parameters {
                configuration.extend_from_slice(&(p.len() as u32).to_be_bytes());
                configuration.extend_from_slice(p);
            }
        }
        self.waiting_for_sync = false;
        Ok(Some(Frame {
            bytes,
            configuration,
            sync,
        }))
    }
    fn payload(&mut self, p: &[u8]) -> Result<(), ()> {
        if p.len() < 2 {
            return Err(());
        }
        match (p[0] >> 1) & 63 {
            48 => {
                if !self.fragment.is_empty() {
                    return Err(());
                };
                let mut offset = 2;
                while offset < p.len() {
                    if offset + 2 > p.len() {
                        return Err(());
                    };
                    let size = u16::from_be_bytes([p[offset], p[offset + 1]]) as usize;
                    offset += 2;
                    if size < 2 || offset + size > p.len() {
                        return Err(());
                    };
                    self.nal(&p[offset..offset + size])?;
                    offset += size;
                }
                Ok(())
            }
            49 => {
                if p.len() < 4 {
                    return Err(());
                };
                let start = p[2] & 128 != 0;
                let end = p[2] & 64 != 0;
                if start && end || p[2] & 63 >= 48 {
                    return Err(());
                }
                if start {
                    if !self.fragment.is_empty() {
                        return Err(());
                    };
                    self.fragment
                        .extend_from_slice(&[(p[0] & 129) | ((p[2] & 63) << 1), p[1]]);
                } else if self.fragment.is_empty() {
                    return Err(());
                }
                if self.fragment.len() + p.len() - 3 > MAX_FRAME {
                    return Err(());
                };
                self.fragment.extend_from_slice(&p[3..]);
                if end {
                    let nal = std::mem::take(&mut self.fragment);
                    self.nal(&nal)?;
                }
                Ok(())
            }
            _ => {
                if !self.fragment.is_empty() {
                    return Err(());
                };
                self.nal(p)
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn primed() -> Assembler {
        let mut a = Assembler::new();
        for (i, t) in [32, 33, 34].iter().enumerate() {
            a.push(i as u16, 0, false, &[t << 1, 1, 7]).unwrap();
        }
        a
    }
    #[test]
    fn sync_frame_and_config() {
        let mut a = primed();
        let f = a.push(3, 0, true, &[19 << 1, 1, 9]).unwrap().unwrap();
        assert!(f.sync);
        assert_eq!(f.configuration.len(), 21);
        assert_eq!(f.bytes, [0, 0, 0, 3, 38, 1, 9]);
    }
    #[test]
    fn lost_fragment_discards_until_sync() {
        let mut a = primed();
        a.push(3, 0, false, &[98, 1, 128 | 19, 1]).unwrap();
        assert!(a.push(5, 0, true, &[98, 1, 64 | 19, 2]).is_err());
        assert!(a.push(6, 1, true, &[2, 1, 7]).unwrap().is_none());
        assert!(a.push(7, 2, true, &[38, 1, 8]).unwrap().is_some());
    }
    #[test]
    fn sequence_wrap() {
        let mut a = primed();
        a.sequence = Some(u16::MAX);
        assert!(a.push(0, 0, true, &[38, 1, 8]).unwrap().is_some());
    }
    #[test]
    fn truncated_aggregate_and_orphan_fragment() {
        let mut a = Assembler::new();
        assert!(a.push(0, 0, true, &[96, 1, 0, 9, 1]).is_err());
        assert!(a.push(1, 0, true, &[98, 1, 64 | 19, 1]).is_err());
    }
    #[test]
    fn missing_marker_cannot_join_frames() {
        let mut a = primed();
        a.push(3, 0, false, &[38, 1, 3]).unwrap();
        assert!(a.push(4, 1, true, &[2, 1, 3]).is_err());
    }
    #[test]
    fn bounded_fragment() {
        let mut a = Assembler::new();
        a.fragment = vec![1; MAX_FRAME];
        assert!(a.push(0, 0, true, &[98, 1, 64 | 19, 1]).is_err());
        assert!(a.fragment.is_empty());
    }
}
