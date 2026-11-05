#pragma once
#include <stdint.h>
#include <stddef.h>
// Called synchronously on the receiver worker. Bytes are borrowed for this call.
// 1: HEVC access unit (4-byte big-endian NAL lengths), flags bit 0 = sync frame.
// 2: HEVC configuration (length-prefixed VPS, SPS, PPS).
// 3: audio RTP payload. Swift additionally emits endpoint metadata as kind 0.
// 5: stream discontinuity; invalidate decoder until a new configuration/keyframe.
typedef void (*IPortalMediaCallback)(void *, uint32_t, uint32_t, uint32_t, const uint8_t *, size_t);
// Takes ownership of both FDs, including on failure. display_fd MUST be an
// authenticated CoreDevice display-service socket. EOF/data on cancel_fd stops
// startup or streaming. Return ends callbacks and closes this receiver's sockets;
// the phone expires its media lease after feedback stops. Never stops other streams.
int32_t iportal_media_run(int32_t display_fd, int32_t cancel_fd, IPortalMediaCallback, void *);
