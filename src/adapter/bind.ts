interface Parameter {
  name: string;
  start: number;
  end: number;
}

export function bind(
  sql: string,
  params: Parameter[],
  placeholder: (name: string, index: number) => string,
): string {
  let text = "";
  let end = 0;
  params.forEach((param, index) => {
    text += sql.slice(end, param.start) + placeholder(param.name, index);
    end = param.end;
  });
  return text + sql.slice(end);
}
