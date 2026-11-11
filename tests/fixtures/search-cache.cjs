// Synthetic historical v1 search inputs, independent of the live passage recipe.
// Counts below are UTF-16 code units, NOT code points. Keep the bodies, offsets,
// framing and IEEE-754 little-endian bytes fixed when production indexing changes.
// Hash literals captured once with node:crypto from these fixed bodies and
// fingerprint + NUL framing, not from production indexing or passages().
const fingerprint = 'synthetic-frozen-search-v1';
const records = [
  { session: 'frozen-multi', title: 'Frozen search', role: 'assistant',
    text: 'a'.repeat(699) + '😀' + 'b'.repeat(699) + '😀' + 'c'.repeat(48) },
  { session: 'frozen-unicode', title: 'Frozen search', role: 'assistant', text: '😀'.repeat(500) },
];
const chunks = [
  { session: 'frozen-multi', offset: 0, keep: true,
    body: 'Frozen search\nassistant\n' + 'a'.repeat(699) + '😀' + 'b'.repeat(99),
    hash: 'edad0e6aa4ec02084385197ab9c13978b3cf109932c38dd9091424bacd16bb6c', bytes: '0000803f' + '00000000'.repeat(383) },
  { session: 'frozen-multi', offset: 700, keep: true,
    body: 'Frozen search\nassistant\n\ude00' + 'b'.repeat(699) + '😀' + 'c'.repeat(48),
    hash: 'eecd8d34e11918969865cf1e6a69df15313803b61b92e64f584215869fca7269', bytes: '0000003f' + '00000000'.repeat(383) },
  // This 50-unit tail is already covered by the preceding 750-unit window.
  { session: 'frozen-multi', offset: 1400, keep: false,
    body: 'Frozen search\nassistant\n😀' + 'c'.repeat(48),
    hash: '2f7f371e173c2401553c4443cf68280c5264db0b85858379ad3506e5e615c96e', bytes: '0000803e' + '00000000'.repeat(383) },
  { session: 'frozen-unicode', offset: 0, keep: true,
    body: 'Frozen search\nassistant\n' + '😀'.repeat(400),
    hash: 'f8781d0695d5ed824e02b3c8fc127e9407367b106bb2ef37ef5bc741c5a6c512', bytes: '00000040' + '00000000'.repeat(383) },
  // 1,000 UTF-16 units, although SQLite length(text) would report only 500:
  // the second window is essential, not a covered tail.
  { session: 'frozen-unicode', offset: 700, keep: true,
    body: 'Frozen search\nassistant\n' + '😀'.repeat(150),
    hash: '7941ef82841079a2d495e5896a39d1c791d6e32e5d4ae0bd67f6633249f852f3', bytes: '00008040' + '00000000'.repeat(383) },
];
module.exports = { fingerprint, records, chunks };
