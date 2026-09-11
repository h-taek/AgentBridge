// 서빙되는 페이지 안에서 도는 유일한 우리 코드다. 페이지는 신뢰 대상이 아니므로 이 스크립트는
// 사용자가 치는 글을 보지 않는다 — 좌표와 요소 정보만 밖으로 보낸다(spec 3.4).
(() => {
  const origin = document.currentScript?.getAttribute('data-ab-origin') ?? '';
  if (!origin) return;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #ff8c00;pointer-events:none;display:none';
  root.appendChild(box);
  document.documentElement.appendChild(host);

  let agent = false;
  let picked: Element | null = null;
  let hover: Element | null = null;

  const send = (msg: unknown) => parent.postMessage(msg, origin);

  // 오버레이는 position:fixed라 화면 기준으로 그린다. 페이지가 스크롤되면 요소는 움직이는데
  // 상자는 그 자리에 남으므로, 스크롤·크기 변화 때마다 다시 그려야 한다.
  const drawBox = (el: Element | null) => {
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.style.display = 'block';
  };
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  // 선택자는 id가 있으면 거기서 끊고, 없으면 nth-of-type으로 네 단계까지 올라간다.
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && parts.length < 4) {
      if (cur.id) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      let index = 1;
      let sibling = cur.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === cur.tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${index})`);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  // 태그명과 data-ab-line을 뺀 속성만 담는다.
  const tagOf = (el: Element): string => {
    const parts: string[] = [el.tagName.toLowerCase()];
    for (let i = 0; i < el.attributes.length; i += 1) {
      const attr = el.attributes[i];
      if (attr.name === 'data-ab-line') continue;
      parts.push(attr.value !== '' ? `${attr.name}="${attr.value}"` : attr.name);
    }
    return parts.join(' ');
  };

  const describe = (el: Element) => {
    const stamped = el.closest('[data-ab-line]');
    return {
      line: Number(stamped?.getAttribute('data-ab-line') ?? 0),
      lineIsAncestor: stamped !== el,
      selector: selectorOf(el),
      tag: tagOf(el),
      text: (el.textContent ?? '').trim(),
    };
  };

  addEventListener('message', (e) => {
    if (e.origin !== origin) return; // 페이지가 자기에게 보낸 것은 출처가 달라 걸러진다
    const d = e.data as { ab?: string; mode?: string };
    if (d?.ab !== 'mode') return;
    agent = d.mode === 'agent';
    if (!agent) {
      box.style.display = 'none';
      picked = null;
      hover = null;
    }
  });

  addEventListener(
    'pointerover',
    (e) => {
      if (!agent) return;
      const el = e.target as Element | null;
      if (!el || !(el instanceof Element)) return;
      hover = el;
      drawBox(hover);
    },
    true,
  );

  addEventListener(
    'click',
    (e) => {
      if (!agent) return;
      e.preventDefault();
      e.stopPropagation();
      picked = e.target as Element;
      send({ ab: 'pick', el: describe(picked), rect: rectOf(picked) });
    },
    true,
  );

  addEventListener(
    'keydown',
    (e) => {
      if (agent && e.key === 'Escape') send({ ab: 'dismiss' });
    },
    true,
  );

  const follow = () => {
    drawBox(hover);
    if (picked) send({ ab: 'rect', rect: rectOf(picked) });
  };
  addEventListener('scroll', follow, true);
  addEventListener('resize', follow);

  send({ ab: 'ready' });
})();
