import { http, HttpResponse, type RequestHandler } from 'msw';

// A 1x1 JPEG.
const JPEG_1X1_BASE64 =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

export const assetHandlers: RequestHandler[] = [
    http.get('*/assets/img/:name', () => {
        const bytes = Buffer.from(JPEG_1X1_BASE64, 'base64');
        return new HttpResponse(bytes, { headers: { 'content-type': 'image/jpeg' } });
    }),
];
