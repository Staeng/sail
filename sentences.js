// 모델이 문장을 한 줄에 몰아서 내보내거나 문장 끝에 " /"를 붙여도 화면에는 "한 문장씩" 나오게 정리한다.

const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m|No)\.$/i;

// 앞뒤에 붙은 끊어읽기 표시(" /")와 중복 공백을 걷어낸다. 문장 가운데의 " / "는 그대로 둔다.
function cleanSentence(s) {
  return String(s)
    .replace(/^[\s/]+/, "")
    .replace(/[\s/]+$/, "")
    .replace(/(?:\s\/){2,}/g, " /")
    .replace(/\s+/g, " ")
    .trim();
}

// 한 줄에 문장이 여러 개 들어 있으면 문장 끝(마침표/물음표/느낌표 + 다음 대문자)에서 나눈다.
function splitSentences(line) {
  const parts = [];
  let start = 0;
  const re = /([.!?]["'”’)]*)(\s+(?:\/\s+)?)(?=["“‘'(]?[A-Z])/g;
  let m;
  while ((m = re.exec(line))) {
    const end = m.index + m[1].length;
    const head = line.slice(start, end);
    if (ABBREV.test(head)) continue; // 약어(Mr. Dr. a.m. 등)는 문장 끝이 아니다
    parts.push(head);
    start = m.index + m[0].length;
  }
  parts.push(line.slice(start));
  return parts.map(cleanSentence).filter(Boolean);
}

module.exports = { splitSentences, cleanSentence };
