m.evaluate((group, submitted) => {
  const bubbles = group.querySelectorAll("[data-user-message-bubble]");
  const contents = bubbles.length === 1 ? [...bubbles[0].querySelectorAll("[data-search-result-target]")].filter((candidate) => {
    const ancestor = candidate.parentElement?.closest("[data-search-result-target]");
    return !ancestor || !bubbles[0].contains(ancestor);
  }) : [];
  const normalize = (text) => text.replace(/\r\n?/g, `
`);
  if (contents.length !== 1)
    return false;
  const content = contents[0];
  const observed = normalize(content.innerText);
  const expected = normalize(submitted.text);
  const equivalent = (actual, escapedMarkdown = false, allowTruncatedPrefix = false) => {
    const punctuation = (unit) => Boolean(unit) && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(unit);
    let observedIndex = 0;
    let expectedIndex = 0;
    while (expectedIndex < expected.length) {
      if (observedIndex === actual.length)
        return allowTruncatedPrefix && actual.length >= 8192 && expected.length - expectedIndex >= 1024;
      if (escapedMarkdown && (actual[observedIndex] === "\\" || expected[expectedIndex] === "\\")) {
        const startExpected = expectedIndex;
        const startObserved = observedIndex;
        while (expected[expectedIndex] === "\\")
          expectedIndex++;
        while (actual[observedIndex] === "\\")
          observedIndex++;
        const original = expectedIndex - startExpected;
        const rendered = observedIndex - startObserved;
        const maximum = 2 * original + (punctuation(expected[expectedIndex]) ? 1 : 0);
        if (rendered < original || rendered > maximum)
          return false;
        if (expectedIndex === expected.length)
          break;
      }
      if (actual[observedIndex] !== expected[expectedIndex] && (expected[expectedIndex] !== " " || actual[observedIndex] !== " " || expected[expectedIndex - 1] !== " " && expected[expectedIndex + 1] !== " "))
        return false;
      observedIndex++;
      expectedIndex++;
    }
    return observedIndex === actual.length;
  };
  if (equivalent(observed))
    return true;
  if (!submitted.appMentionHref)
    return false;
  const mentions = content.querySelectorAll('[data-prompt-link-href^="app://"]');
  if (mentions.length === 1 && mentions[0].getAttribute("data-prompt-link-href") === submitted.appMentionHref) {
    const label = normalize(mentions[0].innerText);
    if (!label || !observed.startsWith(label))
      return false;
    const tail = observed.slice(label.length);
    const payload = tail.startsWith(`
`) ? tail.slice(1) : tail;
    const payloadMatches = (value) => [1, 2].some((size) => /^[ \u00a0]+$/.test(value.slice(0, size)) && equivalent(value.slice(size), true));
    const payloadMatchesTruncatedPrefix = (value) => expected.length >= 65536 && [1, 2].some((size) => /^[ \u00a0]+$/.test(value.slice(0, size)) && equivalent(value.slice(size), true, true));
    if (payloadMatches(payload) || payloadMatchesTruncatedPrefix(payload))
      return true;
    const paragraphs = content.querySelectorAll("p");
    if (paragraphs.length !== 1 || content.textContent !== paragraphs[0].textContent || !paragraphs[0].contains(mentions[0]))
      return false;
    const canonicalText = (node) => {
      if (node === mentions[0])
        return "";
      if (node.nodeType === Node.TEXT_NODE)
        return node.textContent ?? "";
      if (node instanceof Element && node.tagName === "BR")
        return `
`;
      return [...node.childNodes].map(canonicalText).join("");
    };
    const canonical = normalize(canonicalText(paragraphs[0]));
    return payloadMatches(canonical) || payloadMatchesTruncatedPrefix(canonical);
  }
  if (mentions.length === 0 && /^\$[\w-]+ {1,2}/.test(observed))
    return "pending";
  return false;
},{text:t.submittedText,appMentionHref:t.submittedAppMentionHref})
