import { requireActiveCompany } from '@/lib/auth-helpers';
import { ingestUpload } from '@/server/knowledge/ingest.service';
import { isMaterialCategory } from '@/lib/materials';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/knowledge/upload — multipart file upload added to the knowledge
 * base. Uses the Web FormData API (no extra dep).
 *
 * Accepts the formats business material actually arrives in: .pdf, .docx and
 * .pptx alongside plain text. A `category` field records WHAT the document is
 * (pitch deck, brand guidelines, competitor intel...), which decides how
 * heavily it is weighted at retrieval time and how it is described to the
 * model — see lib/materials.ts.
 *
 * `unpdf`/pdf.js needs the Node runtime (not Edge). PDF text extraction can be
 * slow, so we give it more time than the default. Note: serverless platforms
 * cap request bodies (~4.5 MB on Vercel) — larger files 413 before this runs, so
 * we surface a clear size hint below.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED = ['.txt', '.md', '.markdown', '.pdf', '.docx', '.pptx'];
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
      return jsonError(
        'Supported files: .pdf, .docx, .pptx, .txt and .md. For older .doc or .ppt files, save a copy in the newer format first.',
        415,
      );
    }
    if (file.size > MAX_BYTES) {
      return jsonError(
        'File is too large (max ~4 MB). For big PDFs, upload the key pages or paste the text.',
        413,
      );
    }

    // The category is the user's own answer to "what is this document". An
    // unrecognised value is dropped rather than rejected: a mislabelled
    // document is still worth ingesting uncategorised, and failing the whole
    // upload over a dropdown would lose the file for no gain.
    const rawCategory = form.get('category');
    const category =
      typeof rawCategory === 'string' && isMaterialCategory(rawCategory)
        ? rawCategory
        : null;

    const data = await file.arrayBuffer();
    const result = await ingestUpload({
      companyId: company.id,
      userId: user.id,
      filename: file.name,
      mime: file.type,
      data,
      category,
    });
    return jsonOk({ filename: file.name, chunks: result.chunks, category });
  } catch (error) {
    return handleRouteError(error);
  }
}
