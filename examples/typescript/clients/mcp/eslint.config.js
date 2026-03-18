/**
 * ESLint 配置文件
 *
 * 配置 TypeScript、Prettier、JSDoc、Import 等规则。
 *
 * @author kuangyp
 * @version 2025-03-16
 */

import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import importPlugin from "eslint-plugin-import";

export default [
  // 忽略构建产物和依赖目录
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  // TypeScript 文件规则
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: 2022,
      // Node.js 全局变量
      globals: {
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        Buffer: "readonly",
        exports: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    // 启用的插件
    plugins: {
      "@typescript-eslint": ts,
      prettier: prettier,
      jsdoc: jsdoc,
      import: importPlugin,
    },
    // 规则配置
    rules: {
      ...ts.configs.recommended.rules,
      "import/first": "error", // import 必须放在文件顶部
      "prettier/prettier": "error", // 与 Prettier 集成
      "@typescript-eslint/member-ordering": "error", // 成员排序
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_$" }], // 未使用变量，忽略 _ 前缀
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }], // JSDoc 标签换行
      "jsdoc/check-alignment": "error", // JSDoc 对齐检查
      "jsdoc/no-undefined-types": "off", // 允许未定义类型
      "jsdoc/check-param-names": "error", // 参数名与 JSDoc 一致
      "jsdoc/check-tag-names": "error", // 标签名合法
      "jsdoc/check-types": "error", // 类型检查
      "jsdoc/implements-on-classes": "error", // implements 仅用于类
      "jsdoc/require-description": "error", // 必须有描述
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true, // 函数声明需要 JSDoc
            MethodDefinition: true, // 方法需要 JSDoc
            ClassDeclaration: true, // 类需要 JSDoc
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      "jsdoc/require-param": "error", // 必须有 @param
      "jsdoc/require-param-description": "error", // 参数必须有描述
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns": "error", // 有返回值必须有 @returns
      "jsdoc/require-returns-description": "error", // 返回值必须有描述
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-hyphen-before-param-description": ["error", "always"], // 参数描述前需连字符
    },
  },
];
