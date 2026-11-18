import { BadRequestException, Injectable } from "@nestjs/common";
import type { GitHubImageBedConfig } from "./image-bed.types.js";

const DEFAULTS = { branch: "main", pathPrefix: "images", customDomain: "" };

/** 图床配置的唯一读取口：仓库根目录 `.env` 的 `IMAGE_BED_*`。 */
@Injectable()
export class ImageBedConfigService {
  get(): GitHubImageBedConfig {
    const config = this.tryGet();
    if (config) return config;
    throw new BadRequestException("图床未配置：请设置 IMAGE_BED_TOKEN / IMAGE_BED_OWNER / IMAGE_BED_REPO。");
  }

  tryGet(): GitHubImageBedConfig | null {
    const config: GitHubImageBedConfig = {
      token: (process.env.IMAGE_BED_TOKEN || "").trim(),
      owner: (process.env.IMAGE_BED_OWNER || "").trim(),
      repo: (process.env.IMAGE_BED_REPO || "").trim(),
      branch: (process.env.IMAGE_BED_BRANCH || DEFAULTS.branch).trim() || DEFAULTS.branch,
      pathPrefix: this.cleanPrefix(process.env.IMAGE_BED_PATH_PREFIX || DEFAULTS.pathPrefix),
      customDomain: (process.env.IMAGE_BED_CUSTOM_DOMAIN || "").trim().replace(/\/+$/, ""),
    };
    return config.token && config.owner && config.repo ? config : null;
  }

  /** 当前生效配置，token 只留后四位。 */
  describe(): { source: "env" | null; owner: string; repo: string; branch: string; pathPrefix: string; customDomain: string; tokenHint: string } {
    const config = this.tryGet();
    return {
      source: config ? "env" : null,
      owner: config?.owner ?? "",
      repo: config?.repo ?? "",
      branch: config?.branch ?? "",
      pathPrefix: config?.pathPrefix ?? "",
      customDomain: config?.customDomain ?? "",
      tokenHint: config?.token ? `…${config.token.slice(-4)}` : "",
    };
  }

  private cleanPrefix(raw: string): string {
    return raw.split("/").filter((segment) => segment && segment !== "." && segment !== "..").join("/");
  }
}
