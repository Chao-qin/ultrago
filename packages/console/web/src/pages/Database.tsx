import { PageHeader } from '../components/PageHeader';

/** 数据库 — embedded Prisma Studio, the visual browser/editor for the
 *  console's SQLite DB.
 *
 *  The page is just a frame host: Studio lives in its own document
 *  (`studio.html` → `src/studio-main.tsx`) because it owns `location.hash`,
 *  which the console's HashRouter also owns. See studio-main.tsx for the full
 *  reasoning. The iframe is same-origin, so it reaches `/api/studio` directly.
 */
export function Database() {
  return (
    <div className="console-database-page">
      <PageHeader title="数据库" subtitle="浏览表结构、数据与查询结果" />
    <iframe
      className="console-studio-frame"
      // Relative to the SPA document at `/`, matching vite's `base: "./"`.
      src="./studio.html"
      title="数据库"
    />
    </div>
  );
}
