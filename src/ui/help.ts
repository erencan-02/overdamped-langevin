import helpHtml from './help.html?raw';

/**
 * Puts the help dialog (src/ui/help.html: the walkthrough of the mathematics and how to use the
 * app) into the page. Call once at start, before the controls look up its elements. The markup is
 * a fixed file of this app; its formulas (`data-tex`) are typeset when the dialog is first opened,
 * and its list of shortcuts is filled from the keyboard table (app/keyboard.ts).
 */
export function mountHelp(): void {
  if (document.getElementById('help')) return;
  const template = document.createElement('template');
  template.innerHTML = helpHtml;
  const fatal = document.getElementById('fatal');
  document.body.insertBefore(template.content, fatal);
}
