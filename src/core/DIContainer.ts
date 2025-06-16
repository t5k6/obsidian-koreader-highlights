export class DIContainer {
    private instances = new Map<Function, any>();

    register<T>(token: Function, instance: T): void {
        this.instances.set(token, instance);
    }

    resolve<T>(token: Function): T {
        const instance = this.instances.get(token);
        if (!instance) {
            throw new Error(`Service not registered: ${token.name}`);
        }
        return instance;
    }
}
