import type { ConsentContainer, ConsentElement, PageState } from '../domain/types.js';

export class ElementRegistry {
  private elements = new Map<string, ConsentElement>();
  private containers = new Map<string, ConsentContainer>();

  replace(state: PageState): void {
    this.elements = new Map(state.elements.map((element) => [element.id, element]));
    this.containers = new Map(state.containers.map((container) => [container.id, container]));
  }

  get(id: string): ConsentElement | undefined {
    return this.elements.get(id);
  }

  has(id: string): boolean {
    return this.elements.has(id);
  }

  values(): ConsentElement[] {
    return [...this.elements.values()];
  }

  getContainer(id: string): ConsentContainer | undefined {
    return this.containers.get(id);
  }

  clear(): void {
    this.elements.clear();
    this.containers.clear();
  }
}
