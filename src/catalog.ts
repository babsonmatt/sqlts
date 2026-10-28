export interface Column {
  name: string;
  type: string;
  nullable: boolean | null;
}
export interface Relation {
  schema: string;
  name: string;
  visible: boolean;
  columns: Column[];
  origin?: string;
}
export interface Catalog {
  relations: Relation[];
  schemas: string[];
  keywords: string[];
  functions?: SqlFunction[];
  types?: SqlType[];
}

export interface SqlFunction {
  schema: string;
  name: string;
  visible: boolean;
  arguments: string;
  inputTypes: string[];
  defaults?: number;
  variadic?: string | null;
  result: string;
  setReturning: boolean;
  columns: Column[];
}

export interface SqlType {
  name: string;
  element?: string | null;
  rangeSubtype?: string | null;
  multirangeRange?: string | null;
  columns?: Column[];
}
