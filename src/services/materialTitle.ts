export interface SimplifiedTitle {
  shortTitle: string;
  badge?: string;
}

/**
 * Strip verbose prefixes, duplicate English/Chinese suffixes, and parenthetical audio notes
 * so long IELTS/podcast material titles remain scannable.
 */
export function simplifyMaterialTitle(raw: string): SimplifiedTitle {
  const cleaned = raw
    .trim()
    .replace(/[（(][^()（）]*?(?:音频|重制|朗读|配套|练习)[^()（）]*?[）)]/g, '')
    .trim();

  // 1. IOT 练习题 Vol.5 Test 2 Part 3 · Early Childhood Tutorial 幼儿性别差异研讨
  const iotMatch = cleaned.match(
    /^IOT\s*(?:练习题)?\s*Vol\.?\s*(\d+)\s*Test\s*(\d+)\s*Part\s*(\d+)\s*[·•\-:]\s*(.+)$/i,
  );
  if (iotMatch) {
    const [, vol, test, part, rest] = iotMatch;
    const zhMatch = rest.match(/[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9\s\-、，：]+$/);
    const shortTitle = (zhMatch ? zhMatch[0] : rest).trim();
    return {
      shortTitle: truncateTitle(shortTitle),
      badge: `IOT V${vol} T${test} · P${part}`,
    };
  }

  // 2. 机经回忆 2026-09 · 557 · Part 4 · 游牧与季节迁移
  const recalledPartMatch = cleaned.match(
    /^机经(?:回忆)?\s*(\d{4}[-.]\d{1,2}(?:[-.]\d{1,2})?)\s*[·•]\s*(?:\d+\s*[·•]\s*)?(Part\s*\d+)\s*[·•]\s*(.+)$/i,
  );
  if (recalledPartMatch) {
    const [, date, part, topic] = recalledPartMatch;
    const pShort = part.replace(/Part\s*/i, 'P');
    return {
      shortTitle: truncateTitle(topic.trim()),
      badge: `机经 ${date.replace('.', '-')} · ${pShort}`,
    };
  }

  // 3. 机经 2026-10-23 · 驾驶员警报系统
  const recalledDateMatch = cleaned.match(
    /^机经(?:回忆)?\s*(\d{4}[-.]\d{1,2}(?:[-.]\d{1,2})?)\s*[·•]\s*(.+)$/i,
  );
  if (recalledDateMatch) {
    const [, date, topic] = recalledDateMatch;
    return {
      shortTitle: truncateTitle(topic.trim()),
      badge: `机经 ${date.replace('.', '-')}`,
    };
  }

  // 4. 剑桥雅思 19 · Test 2 · Part 1
  const cambridgeMatch = cleaned.match(
    /(?:剑桥(?:雅思)?|剑雅|Cambridge(?:\s+IELTS)?)\s*(\d+)\s*[·•\-]?\s*Test\s*(\d+)\s*[·•\-]?\s*Part\s*(\d+)/i,
  );
  if (cambridgeMatch) {
    const [, book, test, part] = cambridgeMatch;
    return {
      shortTitle: `剑雅 ${book} · T${test} · P${part}`,
    };
  }

  // 5. Graded / Bracketed tier prefix: [L1] 日常对话 · 咖啡店点单 -> badge: 日常对话, shortTitle: 咖啡店点单
  const podMatch = cleaned.match(/^\[(L[1-4])\]\s*(.+)$/i);
  if (podMatch) {
    const rest = podMatch[2].trim();
    const dotIdx = rest.indexOf('·');
    if (dotIdx > 0) {
      const cat = rest.slice(0, dotIdx).trim();
      const body = rest.slice(dotIdx + 1).trim();
      if (cat && body) {
        return {
          shortTitle: truncateTitle(body),
          badge: cat,
        };
      }
    }
    return {
      shortTitle: truncateTitle(rest),
    };
  }

  return { shortTitle: truncateTitle(cleaned) };
}

function truncateTitle(s: string, maxLen = 28): string {
  const t = s.trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).trimEnd() + '…';
}
