// Home of the administration area: every Dashboard section, grouped like the Dashboard's navigation.
import { useMemo, useState } from 'react';
import { mhref } from '../router';
import { Glyph, List, Row, Screen, SearchField, Section } from '../uiKit';
import { Notice } from '../uiExtra';
import { ADMIN_GROUPS, ADMIN_SECTIONS } from './sections';

export function AdminHub() {
  const [term, setTerm] = useState('');
  const items = useMemo(() => {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    return ADMIN_SECTIONS.filter((s) => words.every((w) => `${s.title} ${s.subtitle} ${s.group}`.toLowerCase().includes(w)));
  }, [term]);
  return (
    <Screen title="Administration" subtitle="Everything the local Dashboard offers">
      <div className="mb-4">
        <SearchField label="Search administration" value={term} onChange={setTerm} placeholder="Search administration" />
      </div>
      {!term && (
        <Notice tone="info" className="mb-5" title="Owner administration">
          The same pages and checks as the Dashboard on your Mac. Sensitive changes ask you to confirm once — Face ID, your vault passphrase or your NEBULA password.
        </Notice>
      )}
      {items.length === 0 ? (
        <p className="py-8 text-center text-subhead text-subtle" role="status">
          Nothing matches “{term}”.
        </p>
      ) : (
        ADMIN_GROUPS.map((g) => {
          const rows = items.filter((s) => s.group === g);
          if (!rows.length) return null;
          return (
            <Section key={g} title={g}>
              <List>
                {rows.map((s) => (
                  <Row key={s.id} href={mhref(s.to)} leading={<Glyph tone={s.tone}>{s.icon}</Glyph>} title={s.title} subtitle={s.subtitle} />
                ))}
              </List>
            </Section>
          );
        })
      )}
    </Screen>
  );
}
