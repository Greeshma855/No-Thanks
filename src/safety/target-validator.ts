import type { ConsentContainer, ConsentElement, PageState } from '../domain/types.js';
export function findRegisteredElement(state: PageState, id: string): ConsentElement | undefined {
  return state.elements.find((element) => element.id === id);
}
export function findRegisteredContainer(
  state: PageState,
  id: string,
): ConsentContainer | undefined {
  return state.containers.find((container) => container.id === id);
}
export function isInternalElementId(value: string): boolean {
  return /^guardian-element-\d+$/.test(value);
}
export function isInternalContainerId(value: string): boolean {
  return /^guardian-container-\d+$/.test(value);
}
