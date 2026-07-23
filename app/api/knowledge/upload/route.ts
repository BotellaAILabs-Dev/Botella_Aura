import { requireActiveCompany } from '@/lib/auth-helpers';
import { ingestUpload } from '@/server/knowledge/ingest.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/knowledge/upload — multipart file upload (.txt/.md/.pdf) added to
 * the knowledge base. Uses the Web FormData API (no extra dep).
 */
const ALLOWED = ['.txt', '.md', '.markdown', '.pdf'];

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
