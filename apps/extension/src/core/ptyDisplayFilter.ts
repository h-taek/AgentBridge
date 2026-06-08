// 코어의 PtyDisplayFilter 클래스를 그대로 export, 단 logger를 익스텐션 output에 바인딩한 wrapper.

import { PtyDisplayFilter as CorePtyDisplayFilter } from '@agentbridge/core';
import * as output from '../log/output';

export class PtyDisplayFilter extends CorePtyDisplayFilter {
  constructor() {
    super({ logger: { log: (m) => output.log(m), warn: (m) => output.warn(m) } });
  }
}
