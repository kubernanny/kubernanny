import type { RouteMeta } from '@analogjs/router';

import { DocViewComponent } from '../../components/doc-view.component';
import { docResolver } from '../../core/doc.resolver';

export const routeMeta: RouteMeta = {
  resolve: { doc: docResolver },
};

export default DocViewComponent;
