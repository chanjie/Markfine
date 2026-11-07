import { t } from './localization';
const quotes = [
  ['不必一下写得很好。写下一句，就是一个开始。', 'It needn’t be perfect. One sentence is a beginning.'],
  ['今天的灵感，可以小到只有一个词。', 'Today’s inspiration can be as small as a single word.'],
  ['这里没有催促，只有等你落下的文字。', 'No hurry here. Just a little room for your words.'],
  ['慢一点也没关系，文字会跟上你的步伐。', 'Take your time. The words will find their way.'],
  ['把纷乱留在窗外，把想法轻轻放在这里。', 'Leave the noise outside. Set your thoughts down here.'],
  ['你认真记录的日常，本身就值得被留下。', 'The ordinary things you notice are worth keeping.'],
  ['一张空白页，也是一种新的可能。', 'A blank page is another possibility.'],
  ['休息一会儿也很好。你的想法会等你。', 'It’s okay to pause. Your ideas will wait for you.']
];
let quote = -1;
export function renderEmptyState(rotate = false): void {
  if (quote < 0) quote = Math.floor(Math.random() * quotes.length);
  else if (rotate) quote = (quote + 1 + Math.floor(Math.random() * (quotes.length - 1))) % quotes.length;
  document.getElementById('empty-quote')!.textContent = t(quotes[quote][0], quotes[quote][1]);
  document.getElementById('empty')!.dataset.mood = String(quote % 3);
  const tips = document.getElementById('empty-tips')!; tips.replaceChildren();
  for (const [key, zh, en] of [['⌘N / ⌘O', '开始写作，或打开一篇 Markdown', 'Start writing, or open a Markdown file'], ['⇧⌘R', '让页面安静下来，进入阅读', 'Settle into a quiet reading view'], ['⌘,', '选择字体、纸张和语言', 'Choose your fonts, paper and language']]) {
    const row = document.createElement('div'), kbd = document.createElement('kbd'); kbd.textContent = key; row.append(kbd, document.createTextNode(t(zh, en))); tips.append(row);
  }
}
