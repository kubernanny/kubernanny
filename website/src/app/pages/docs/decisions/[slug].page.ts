import type { RouteMeta } from '@analogjs/router';
import { docResolver } from '../../../core/doc.resolver';
import { DocViewComponent } from '../../../components/doc-view.component';

export const routeMeta: RouteMeta = {
  resolve: { doc: docResolver },
};

export default DocViewComponent;
