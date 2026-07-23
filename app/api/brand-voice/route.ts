import { requireActiveCompany } from '@/lib/auth-helpers';
import { getCompanyById } from '@/server/services/company.service';
import {
  generateBrandVoiceProfile,
  getBrandVoiceProfile,
  updateBrandVoiceProfile,
} from '@/server/content/brand-voice.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET — current brand voice profile (or null). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const full = await getCompanyById(company.id);
    return jsonOk({ profile: full ? getBrandVoiceProfile(full) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST — (re)generate the brand voice profile from ingested content. */
export async function POST() {
  try {
    const { company, user } = await requireActiveCompany();
    const full = await getCompanyById(company.id);
    if (!full) return jsonError('Company not found', 404);
    const profile = await generateBrandVoiceProfile({
      company: full,
      userId: user.id,
      force: true,
    });
    return jsonOk({ profile });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PUT — save human edits to the profile. */
export async function PUT(req: Request) {
  try {
    const { company, user } = await requireActiveCompany();
    const profile = await updateBrandVoiceProfile(
      company.id,
      user.id,
      await req.json(),
    );
    return jsonOk({ profile });
  } catch (error) {
    return handleRouteError(error);
  }
}
