import type { Recipe } from '../state/recipes';

/** Presentation only: catalogue identities and apply/preview behaviour remain unchanged. */
export function recipePresentation(recipe: Recipe) {
  if (recipe.blockKind) return {
    type: 'block-recipe' as const,
    label: 'Block recipe', badge: 'RECIPE',
    help: recipe.kinds.length
      ? 'Changes this block to Motion and adds its effects. Needs a preceding Picture block.'
      : 'Changes this block to Motion. Needs a preceding Picture block; no effect container is added.',
    placeholder: 'Timeline change',
    about: 'About this recipe',
    action: (block: number) => `Make Block ${block} Motion`,
  };
  return {
    type: 'look' as const,
    label: recipe.lookId ? 'Project Look' : 'Built-in Look',
    badge: recipe.lookId ? 'YOUR LOOK' : 'LOOK',
    help: recipe.lookId
      ? 'A saved graph in this project. Adds an independent container copy, with its saved controls, in one undo step.'
      : 'An effect graph added as a container, with its authored controls, in one undo step.',
    placeholder: 'Graph Look',
    about: 'About this look',
    action: (block: number) => `Apply to Block ${block}`,
  };
}

export function recipeGroupLabel(recipes: Recipe[]): string {
  const blocks = recipes.some(recipe => recipePresentation(recipe).type === 'block-recipe');
  const looks = recipes.some(recipe => recipePresentation(recipe).type === 'look');
  return blocks ? (looks ? 'Looks & recipes' : 'Block recipes') : 'Looks';
}
