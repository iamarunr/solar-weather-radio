// Small DOM and formatting helpers shared by the page's modules.

export const $ = id => document.getElementById(id);

/** Create an element. Text is always set as text, never parsed as HTML. */
export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// Date formatters are costly to build, so make each one once. All use the visitor's locale and timezone.
const formatter = options => {
  const format = new Intl.DateTimeFormat([], options);
  return time => format.format(new Date(time));
};
export const hhmm = formatter({ hour: '2-digit', minute: '2-digit' });
export const dayTime = formatter({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const weekdayTime = formatter({ weekday: 'short', hour: '2-digit', minute: '2-digit' });

export const NEW_TAB_NOTE = ' (opens in a new tab)';
