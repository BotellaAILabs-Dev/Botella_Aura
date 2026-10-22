// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined, warning: () => undefined }),
}));

import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox';
import { GraphicStudio } from '@/components/dashboard/content/graphic-studio';

/**
 * The full-screen image preview (components/ui/image-lightbox.tsx) and how
 * Content Studio opens it: a click on a generated image enlarges it.
 */

const IMAGES: LightboxImage[] = [
  { src: '/api/content/graphics/a1/file', alt: 'First', width: 1024, height: 1280, downloadName: 'graphic-a1.png' },
  { src: '/api/content/graphics/a2/file', alt: 'Second', width: 1024, height: 1024, downloadName: 'graphic-a2.png' },
  { src: '/api/content/graphics/a3/file', alt: 'Third', width: 1536, height: 1024, downloadName: 'graphic-a3.png' },
];

function Harness({ start = 0, images = IMAGES, onClose = vi.fn() }: { start?: number | null; images?: LightboxImage[]; onClose?: () => void }) {
  const [index, setIndex] = useState<number | null>(start);
  return (
    <ImageLightbox
      images={images}
      index={index}
      onIndexChange={setIndex}
      onClose={() => {
        setIndex(null);
        onClose();
      }}
    />
  );
}

const shown = () => screen.getByRole('dialog').querySelector('img')!;

describe('ImageLightbox', () => {
  it('shows the full-resolution image, whole, with a loading indicator until it loads', () => {
    render(<Harness />);
    const img = shown();
    expect(img).toHaveAttribute('src', '/api/content/graphics/a1/file');
    expect(img).toHaveAttribute('alt', 'First');
    expect(img.className).toContain('object-contain');
    expect(screen.getByRole('status')).toHaveTextContent(/loading image/i);
    fireEvent.load(img);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so when the image cannot be loaded', () => {
    render(<Harness />);
    fireEvent.error(shown());
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('moves between images with the buttons and the arrow keys, wrapping round', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /next image/i }));
    expect(shown()).toHaveAttribute('alt', 'Second');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(shown()).toHaveAttribute('alt', 'Third');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(shown()).toHaveAttribute('alt', 'First');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(shown()).toHaveAttribute('alt', 'Third');
    fireEvent.click(screen.getByRole('button', { name: /previous image/i }));
    expect(shown()).toHaveAttribute('alt', 'Second');
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('offers a download of the image shown', () => {
    render(<Harness start={2} />);
    const link = screen.getByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', '/api/content/graphics/a3/file');
    expect(link).toHaveAttribute('download', 'graphic-a3.png');
  });

  it('closes with the X, with Escape, and with a click outside the image — not on it', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    fireEvent.click(shown());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('lightbox-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close preview/i }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('a single image has no navigation, and a closed preview renders nothing', () => {
    const { unmount } = render(<Harness images={[IMAGES[0]!]} />);
    expect(screen.queryByRole('button', { name: /next image/i })).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 1')).not.toBeInTheDocument();
    unmount();
    render(<Harness start={null} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('locks the page behind it from scrolling while open', () => {
    const { unmount } = render(<Harness />);
    // Radix locks scrolling on the body while a modal dialog is open.
    expect(document.body.style.pointerEvents === 'none' || document.body.hasAttribute('data-scroll-locked')).toBe(true);
    unmount();
  });
});

describe('Content Studio opens the preview', () => {
  const asset = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    url: `/api/content/graphics/${id}/file`,
    provider: 'GOOGLE',
    model: 'gemini-image',
    prompt: 'A candle-lit wine tasting table, real photograph.',
    aspectRatio: '4:5',
    width: 1024,
    height: 1280,
    mimeType: 'image/png',
    fileSize: 120_000,
    createdAt: '2026-10-22T10:00:00.000Z',
    attached: false,
    ...extra,
  });

  it('clicking a generated image opens it large, and arrows step through the others', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ providers: [], usage: null, assets: [] }) })));
    render(
      <GraphicStudio
        draftId="draft_1"
        platform="LINKEDIN"
        platformLabel="LinkedIn"
        defaultRatio="1:1"
        initialAssets={[asset('a1', { createdAt: '2026-10-22T10:01:00.000Z' }), asset('a2')]}
        attachedAssetIds={[]}
        activeJobId={null}
        canEdit
      />,
    );
    const tiles = screen.getAllByRole('button', { name: /in a larger view/i });
    await act(async () => {
      fireEvent.click(tiles[0]!);
    });
    const dialog = screen.getByRole('dialog');
    const img = within(dialog).getByRole('img');
    expect(img).toHaveAttribute('src', '/api/content/graphics/a1/file');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/api/content/graphics/a2/file');
    // The selection follows what is being looked at, so closing lands on it.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/selected graphic/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
