import { describe, expect, it } from "vitest";

import { bindControlPlaneServices, bindServicePrototype } from "./control-plane-service-bind.ts";

class Core {
  value = "core";
  own(): string {
    return "own";
  }
}

class Extra {
  extra(): string {
    return "extra";
  }
  get computed(): string {
    return "skip-accessor";
  }
}

class Override {
  own(): string {
    return "override";
  }
}

describe("control-plane service prototype bind", () => {
  it("copies function methods and skips constructors, accessors, and existing names", () => {
    bindServicePrototype(Core, Extra);
    bindServicePrototype(Core, Override);
    const core = new Core() as Core & Extra;
    expect(core.own()).toBe("own");
    expect(core.extra()).toBe("extra");
    expect(Object.prototype.hasOwnProperty.call(Core.prototype, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(Core.prototype, "computed")).toBe(false);
  });

  it("binds several services onto one facade prototype", () => {
    class Facade {
      n(): number {
        return 1;
      }
    }
    class A {
      a(): string {
        return "a";
      }
    }
    class B {
      b(): string {
        return "b";
      }
    }
    bindControlPlaneServices(Facade, [A, B]);
    const facade = new Facade() as Facade & A & B;
    expect(facade.n()).toBe(1);
    expect(facade.a()).toBe("a");
    expect(facade.b()).toBe("b");
  });
});
