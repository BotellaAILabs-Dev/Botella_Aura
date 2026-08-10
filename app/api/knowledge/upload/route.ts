import { requireActiveCompany } from '@/lib/auth-helpers';
import { ingestUpload } from '@/server/knowledge/ingest.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/knowledge/upload — multipart file upload (.txt/.md/.pdf) added to
 * the knowledge base. Uses the Web FormData API (no extra dep).
 *
 * `unpdf`/pdf.js needs the Node runtime (not Edge). PDF text extraction can be
 * slow, so we give it more time than the default. Note: serverless platforms
 * cap request bodies (~4.5 MB on Vercel) — larger files 413 before this runs, so
 * we surface a clear size hint below.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED = ['.txt', '.md', '.markdown', '.pdf'];
// Keep under typical serverless body caps; oversized files fail at the platform.
const MAX_BYTES = 4_000_000;

export async function POST(req: Request) {
  try {
    const { company, user } = await requireActiveCompany();
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return jsonError('No file provided.', 400);
    }
    const name = file.name.toLowerCase();
    if (!ALLOWED.some((ext) => name.endsWith(ext))) {
      return jsonError('Only .txt, .md, and .pdf files are supported.', 415);
    }
    if (file.size > MAX_BYTES) {
      return jsonError(
        'File is too large (max ~4 MB). For big PDFs, upload the key pages or paste the text.',
        413,
      );
    }

    const data = await file.arrayBuffer();
    const result = await ingestUpload({
      companyId: company.id,
      userId: user.id,
      filename: file.name,
      mime: file.type,
      data,
    });
    return jsonOk({ filename: file.name, chunks: result.chunks });
  } catch (error) {
    return handleRouteError(error);
  }
}
