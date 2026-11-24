export interface DocLink {
  route: string;
  label: string;
}

export interface DocNavEntry extends DocLink {
  file: string;
  slug: string;
}

export interface DocNavGroup {
  title: string;
  items: DocNavEntry[];
}

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface DocPage {
  slug: string;
  route: string;
  file: string;
  title: string;
  description: string;
  html: string;
  toc: TocEntry[];
  hasMermaid: boolean;
  editUrl: string;
  sourceUrl: string;
  inNav: boolean;
  section: string | null;
  prev: DocLink | null;
  next: DocLink | null;
}

export interface ComponentGroup {
  category: string;
  components: { name: string; deep: boolean }[];
}
