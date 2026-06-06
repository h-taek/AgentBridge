// apps/extension/test/transcriptReader.protobuf.test.ts
import { strict as assert } from 'assert';
import { decodeProtobuf, collectStrings } from '@agentbridge/core';

describe('transcriptReader/protobuf', () => {
  it('decodes a flat message: field2=string, field3=varint', () => {
    const buf = Buffer.from([0x12, 0x02, 0x68, 0x69, 0x18, 0x05]);
    const fields = decodeProtobuf(buf);
    // field 2 → string "hi"
    const f2 = fields.find((f) => f.field === 2 && f.kind === 'bytes');
    assert.ok(f2);
    assert.equal((f2!.value as Buffer).toString('utf8'), 'hi');
    const f3 = fields.find((f) => f.field === 3 && f.kind === 'varint');
    assert.equal(f3!.value, 5);
  });

  it('collectStrings: returns readable string fields by number (recursive)', () => {
    // 바깥 field1(wt2) 안에 field2(wt2)="hi" 중첩
    const inner = Buffer.from([0x12, 0x02, 0x68, 0x69]); // field2="hi"
    const outer = Buffer.concat([
      Buffer.from([0x0a, inner.length]), // field1, wt2, len
      inner,
    ]);
    const strings = collectStrings(outer, 4);
    assert.ok(strings.some((s) => s.text === 'hi'));
  });

  it('ignores non-utf8 / binary length-delimited fields gracefully', () => {
    const buf = Buffer.from([0x12, 0x02, 0xff, 0xfe]); // field2 = invalid utf8
    const strings = collectStrings(buf, 4);
    assert.equal(strings.length, 0);
  });
});
