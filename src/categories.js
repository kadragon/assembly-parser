// Interest categories route topics. Explicit categories are named, ordered, and name exactly one
// fallback for everything else. The legacy focus flags stay a shorthand for "<focus>" / "그외",
// and no focus at all is a single overall category.
const FIELDS = ['name', 'description', 'keywords', 'fallback'];
const MAX_CATEGORIES = 12;
const MAX_KEYWORDS = 30;

// line breaks and tabs are allowed in descriptions; other control characters are not
const control = (c) => (c < ' ' && c !== '\n' && c !== '\t') || c === '\x7f';
const text = (value, label, max) => {
  if (typeof value !== 'string' || value.length > max || [...value].some(control))
    throw new Error(`Invalid ${label}`);
  return value.trim();
};

/** Validated, normalized category list; [] means no explicit categories. */
export function validateCategories(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_CATEGORIES)
    throw new Error(`Categories must be a list of at most ${MAX_CATEGORIES}`);
  const categories = input.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Invalid category');
    for (const key of Object.keys(c))
      if (!FIELDS.includes(key)) throw new Error(`Unknown category field: ${key}`);
    const name = text(c.name ?? '', 'category name', 100);
    if (!name || name.includes('\n')) throw new Error('Category names must be one nonempty line');
    const keywords = c.keywords ?? [];
    if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS)
      throw new Error(`Keywords must be a list of at most ${MAX_KEYWORDS}`);
    if (c.fallback !== undefined && typeof c.fallback !== 'boolean')
      throw new Error('Invalid fallback flag');
    return {
      name,
      description: text(c.description ?? '', 'category description', 2000),
      keywords: [
        ...new Set(
          keywords.map((k) => text(k, 'keyword', 100).replace(/\s+/g, ' ')).filter(Boolean),
        ),
      ],
      fallback: c.fallback === true,
    };
  });
  const names = categories.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Error('Category names must be unique');
  if (categories.length && categories.filter((c) => c.fallback).length !== 1)
    throw new Error('Choose exactly one fallback category');
  return categories;
}

/**
 * Routing rules for a settings object: { names, fallback, rules }. `rules` is null for the
 * legacy shorthand and the overall summary, whose prompts stay as they were.
 */
export function categoryRules(settings) {
  if (settings.categories?.length)
    return {
      names: settings.categories.map((c) => c.name),
      fallback: settings.categories.find((c) => c.fallback).name,
      rules: settings.categories,
    };
  const names = settings.focus ? [settings.focus, '그외'] : ['전체'];
  return { names, fallback: names.at(-1), rules: null };
}
