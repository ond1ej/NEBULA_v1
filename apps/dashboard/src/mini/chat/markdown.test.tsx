import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Markdown, parseBlocks, safeHref } from './markdown';

describe('Markdown in messages', () => {
  it('renders paragraphs, emphasis, inline code, lists, quotes and headings as elements', () => {
    const { container } = render(
      <Markdown text={'# Report\n\nThis is **bold**, *italic*, ~~old~~ and `code`.\nSecond line\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\nsnake_case_name stays'} />,
    );
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(container.querySelector('del')).toHaveTextContent('old');
    expect(container.querySelector('code.nb-inline')).toHaveTextContent('code');
    expect(container.querySelector('br')).not.toBeNull();
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('blockquote')).toHaveTextContent('quoted');
    expect(screen.getByText(/snake_case_name stays/)).toBeInTheDocument();
  });

  it('never injects HTML and links only http(s) URLs with rel="noopener noreferrer" target="_blank"', () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n[safe](https://example.com/a?b=1) [bad](javascript:alert(1)) [data](data:text/html,x) and https://nebula.example/docs.'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'https://nebula.example/docs']);
    for (const a of links) {
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
      expect(a).toHaveAttribute('target', '_blank');
    }
    expect(screen.getByText('bad').closest('a')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('HTTPS://Example.com')).toBe('https://example.com/');
  });

  it('fenced code blocks keep their text verbatim and offer Copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const code = 'const x = 1;\nif (x < 2) console.log("<b>");';
    const { container } = render(<Markdown text={`Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone`} />);
    expect(container.querySelector('pre code')?.textContent).toBe(code);
    const block = container.querySelector('.nb-code') as HTMLElement;
    expect(within(block).getByText('ts')).toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(await within(block).findByRole('button', { name: 'Code copied' })).toBeInTheDocument();
  });

  it('parses an unterminated fence as code to the end and keeps list continuation lines', () => {
    expect(parseBlocks('```\nopen')).toEqual([{ t: 'code', lang: '', code: 'open' }]);
    expect(parseBlocks('- a\n  more\n- b')).toEqual([{ t: 'ul', items: ['a\nmore', 'b'], start: 1 }]);
  });
});
