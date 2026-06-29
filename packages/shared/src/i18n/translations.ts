/**
 * Internationalization translations for onboarding flow
 * Supports: English, Spanish, French, German, Chinese, Japanese
 */

export type SupportedLanguage = 'en' | 'es' | 'fr' | 'de' | 'zh' | 'ja'

export interface OnboardingTranslations {
  // Language selection
  languageSelection: {
    title: string
    options: {
      en: string
      es: string
      fr: string
      de: string
      zh: string
      ja: string
    }
  }

  // Theme selection
  themeSelection: {
    title: string
  }

  // Role selection
  roleSelection: {
    title: string
    options: {
      development: string
      projectManagement: string
      infrastructure: string
      media: string
      workflow: string
    }
  }

  // Devtools selection
  devtoolsSelection: {
    title: string
    subtitle?: string
  }

  // Interests selection
  interestsSelection: {
    title: string
    options: {
      webdev: string
      mobiledev: string
      backend: string
      scripts: string
      datascience: string
      devops: string
      gamedev: string
      pm: string
      others: string
    }
  }

  // Common UI elements
  ui: {
    next: string
    back: string
    installingDependencies: string
    confirm: string
    skip: string
    connectGitHub: string
    grantPermissions: string
    redirectingToGitHub: string
  }

  // Greetings
  greetings: {
    morning: string
    afternoon: string
    evening: string
  }

  // HomePage elements
  homePage: {
    inputPlaceholder: string
    toolchainHeader: string
    suggestedChatsHeader: string
    bottomNav: {
      home: string
      repo: string
      chat: string
      runtime: string
    }
  }

  // Role-based chat suggestions
  roleSuggestions: {
    development: string[]
    projectManagement: string[]
    infrastructure: string[]
    media: string[]
    workflow: string[]
  }

  // MachineConf elements
  machineConf: {
    nameYourMachine: string
    enterMachineName: string
    settingUpMachine: string
    welcomeToPortable: string
    workstationCreated: string
    proceed: string
    selectPlan: string
    startCodingToday: string
    continue: string
    thankYouEarlyAccess: string
    thankYouPro: string
    // Thank you screen buttons
    checkingAccess: string
    continueToApp: string
    nextStepsButton: string
    backToHome: string
    // Next steps screen content
    nextSteps: {
      earlyAccess: {
        mainAction: string
        timing: string
        items: string[]
      }
      proPlan: {
        mainAction: string
        timing: string
        items: string[]
      }
    }
    pricing: {
      free: {
        price: string
        title: string
        description: string
        features: string[]
      }
      pro: {
        price: string
        title: string
        description: string
        features: string[]
      }
      perMonth: string
    }
    soldOutDialog: {
      title: string
      message: string
      continueForFree: string
    }
  }

  // Grant permissions screen
  grantPermissions: {
    title: string
    subtitle: string
    requiredPermissions: string
    permissions: {
      codeAccess: {
        title: string
        description: string
      }
      webhooks: {
        title: string
        description: string
      }
      pullRequests: {
        title: string
        description: string
      }
    }
    securityAlert: string
    authorizeButton: string
    maybeLater: string
  }

  // Welcome slides (onboarding-app)
  welcomeSlides: {
    slides: {
      welcome: {
        title: string
        subtitle: string
        perfectFor: string
        features: {
          bugFixes: string
          mobileDev: string
          aiAssistance: string
          deployAnywhere: string
        }
      }
      howItWorks: {
        title: string
        subtitle: string
        steps: {
          browse: { title: string; description: string }
          chat: { title: string; description: string }
          action: { title: string; description: string }
        }
      }
      almostReady: {
        title: string
        subtitle: string
        settingUp: string
        ready: string
      }
    }
    navigation: {
      previous: string
      next: string
      continue: string
      finishingSetup: string
    }
  }

  // Provisioning status messages (onboarding-app)
  provisioningStatus: {
    checkingEnvironment: string
    connectingRepositories: string
    waitingForServer: string
    checkingServerStatus: string
    serverReady: string
    verificationTimeout: string
    verificationFailed: string
  }

  // Connect repos page
  connectRepos: {
    title: string
    descriptionUpgrade: string
    descriptionConnect: string
    signingOut: string
    signInButton: string
    skipUpgrade: string
    skipConnect: string
  }

  // Install prompt (PWA)
  installPrompt: {
    appName: string
    company: string
    tagline: string
    viewButton: string
    installButton: string
    installTitle: string
    tapShare: string
    selectAddToHome: string
    tapAddToHome: string
    tapBrowserMenu: string
  }
}

export const translations: Record<SupportedLanguage, OnboardingTranslations> = {
  en: {
    languageSelection: {
      title: 'Choose your language',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: 'Choose your theme',
    },
    roleSelection: {
      title: 'How will you use Portable?',
      options: {
        development: 'Software development',
        projectManagement: 'Project management',
        infrastructure: 'Infrastructure and DevOps',
        media: 'Media and creative',
        workflow: 'Workflow automation',
      },
    },
    devtoolsSelection: {
      title: 'Add framework shortcuts',
      subtitle: 'You can always add more later.',
    },
    interestsSelection: {
      title: 'What will you build on Portable?',
      options: {
        webdev: 'Website or web app (front-end or full stack)',
        mobiledev: 'Mobile App (iOS, Android, Cross-platform)',
        backend: 'Backend services & APIs',
        scripts: 'Scripts / Automation / Internal Tools',
        datascience: 'Data, Analytics, or ML Project',
        devops: 'Infrastructure / DevOps',
        gamedev: 'Videogame or Game Related Tools',
        pm: 'Project Management (Tickets, Roadmaps, Requirements)',
        others: 'Others',
      },
    },
    ui: {
      next: 'Next',
      back: 'Back',
      installingDependencies: 'installing dependencies',
      confirm: 'Confirm',
      skip: 'Skip',
      connectGitHub: 'Connect GitHub',
      grantPermissions: 'Grant Permissions',
      redirectingToGitHub: 'Redirecting to GitHub...',
    },
    greetings: {
      morning: 'Good morning',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
    },
    homePage: {
      inputPlaceholder: 'Work on anything',
      toolchainHeader: 'Toolchain',
      suggestedChatsHeader: 'Suggested chats',
      bottomNav: {
        home: 'Home',
        repo: 'Repo',
        chat: 'Chat',
        runtime: 'Runtime',
      },
    },
    roleSuggestions: {
      development: [
        'Review the authentication flow in the API',
      ],
      projectManagement: [
        'Generate sprint progress report',
      ],
      infrastructure: [
        'Optimize deployment pipeline',
      ],
      media: [
        'Design new onboarding flow',
      ],
      workflow: [
        'Automate repetitive tasks',
      ],
    },
    machineConf: {
      nameYourMachine: 'Name your machine',
      enterMachineName: 'Enter machine name',
      settingUpMachine: 'Setting up machine...',
      welcomeToPortable: 'Welcome to Portable',
      workstationCreated: 'Your workstation has been successfully created and is ready to use.',
      proceed: 'Proceed',
      selectPlan: 'Select plan',
      startCodingToday: 'Start coding today, Upgrade anytime',
      continue: 'Continue',
      thankYouEarlyAccess: 'Thank you for joining our early access!',
      thankYouPro: 'Thank you for choosing Pro!',
      checkingAccess: 'Checking access...',
      continueToApp: 'Continue to App',
      nextStepsButton: 'Next Steps',
      backToHome: 'Back to Home',
      nextSteps: {
        earlyAccess: {
          mainAction: "We'll be in contact shortly",
          timing: 'Look for an email from our team, typically within 2 business hours',
          items: [
            'Invite you to join the early access program',
            'Help you set up the latest version of Portable',
            'Get you connected with our dev team',
          ],
        },
        proPlan: {
          mainAction: 'Brief onboarding call',
          timing: 'Our team is reaching out over email to schedule a white glove onboarding call. Or contact us at contact@portable.dev',
          items: [
            'White-glove setup service tailored to your use case',
            'Access credentials and personalized onboarding',
            'Direct support to get you up and running',
          ],
        },
      },
      pricing: {
        free: {
          price: 'Free',
          title: 'Early Access',
          description: 'Access cutting-edge features and help us improve the app',
          features: [
            'All the features of the pro plan',
            "Latest features as they're built",
            'Direct group chat with the devs',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: 'For serious developers who need to do work on the phone',
          features: [
            'Full GitHub integration',
            'Unlimited active projects',
            '500 server hours per month',
            'AI coding assistance',
            'Live preview & agent testing',
            'Advanced voice mode',
          ],
        },
        perMonth: 'mo',
      },
      soldOutDialog: {
        title: 'Thank you for your interest!',
        message: "This plan is currently sold out, but we're working hard to bring it back soon.",
        continueForFree: 'Continue for Free',
      },
    },
    grantPermissions: {
      title: 'Additional Permissions Required',
      subtitle: 'Portable needs additional GitHub permissions to access your repositories and provide full functionality.',
      requiredPermissions: 'REQUIRED PERMISSIONS:',
      permissions: {
        codeAccess: {
          title: 'Read and write access to code',
          description: 'Allows Portable to clone, push, and manage your repositories.',
        },
        webhooks: {
          title: 'Manage webhooks',
          description: 'Enables Portable to set up webhooks for real-time updates.',
        },
        pullRequests: {
          title: 'Access pull requests and issues',
          description: 'Lets Portable help you manage your development workflow.',
        },
      },
      securityAlert: 'Your data is secure. All code runs in your isolated environment. We never store your repository contents.',
      authorizeButton: 'Authorize GitHub',
      maybeLater: 'Maybe later',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: 'Welcome to Portable!',
          subtitle: 'Your mobile GitHub companion with AI assistance. Code, review, and deploy from anywhere.',
          perfectFor: 'Perfect for:',
          features: {
            bugFixes: 'Quick bug fixes on the go',
            mobileDev: 'Mobile-first development',
            aiAssistance: 'AI-powered code assistance',
            deployAnywhere: 'Deploy from anywhere',
          },
        },
        howItWorks: {
          title: 'How Portable Works',
          subtitle: 'Portable combines GitHub with AI to create a powerful mobile development workflow',
          steps: {
            browse: { title: 'Browse GitHub', description: 'Access all your repositories and issues from your phone' },
            chat: { title: 'Chat with AI', description: 'Ask Claude to help with coding, debugging, and reviews' },
            action: { title: 'Take Action', description: 'Push changes, create PRs, and manage your projects' },
          },
        },
        almostReady: {
          title: 'Almost Ready!',
          subtitle: "Your workspace is being prepared. Once ready, we'll connect your GitHub repositories.",
          settingUp: 'Setting up your environment...',
          ready: 'Workspace ready!',
        },
      },
      navigation: {
        previous: 'Previous',
        next: 'Next',
        continue: 'Continue',
        finishingSetup: 'Finishing setup...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: 'Checking your environment...',
      connectingRepositories: 'Connecting your repositories...',
      waitingForServer: 'Waiting for server to initialize...',
      checkingServerStatus: 'Checking server status',
      serverReady: 'Server ready!',
      verificationTimeout: 'Timeout - redirecting anyway...',
      verificationFailed: 'Could not verify server status - redirecting anyway...',
    },
    connectRepos: {
      title: 'Sign in with GitHub Required',
      descriptionUpgrade: 'To upgrade your permissions, you need to sign in with GitHub. This will allow Portable to request additional access to your repositories.',
      descriptionConnect: 'To connect your repositories, you need to sign in with GitHub. This will allow Portable to access your code and manage repositories on your behalf.',
      signingOut: 'Signing out...',
      signInButton: 'Sign in with GitHub',
      skipUpgrade: 'Continue with current permissions',
      skipConnect: 'Skip for now (limited functionality)',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: 'Mobile-native AI code environment',
      viewButton: 'View',
      installButton: 'Install',
      installTitle: 'Install Portable:',
      tapShare: 'Tap the Share button',
      selectAddToHome: 'Select "Add to Home Screen"',
      tapAddToHome: 'Tap "Add to Home Screen"',
      tapBrowserMenu: 'Tap your browser\'s menu',
    },
  },
  es: {
    languageSelection: {
      title: 'Elige tu idioma',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: 'Elige tu tema',
    },
    roleSelection: {
      title: '¿Cómo usarás Portable?',
      options: {
        development: 'Desarrollo de software',
        projectManagement: 'Gestión de proyectos',
        infrastructure: 'Infraestructura y DevOps',
        media: 'Medios y creatividad',
        workflow: 'Automatización de flujos de trabajo',
      },
    },
    devtoolsSelection: {
      title: 'Agregar atajos de frameworks',
      subtitle: 'Siempre puedes agregar más después.',
    },
    interestsSelection: {
      title: '¿Qué construirás en Portable?',
      options: {
        webdev: 'Sitio web o aplicación web (front-end o full stack)',
        mobiledev: 'Aplicación móvil (iOS, Android, multiplataforma)',
        backend: 'Servicios backend y APIs',
        scripts: 'Scripts / Automatización / Herramientas internas',
        datascience: 'Proyecto de datos, análisis o ML',
        devops: 'Infraestructura / DevOps',
        gamedev: 'Videojuego o herramientas relacionadas con juegos',
        pm: 'Gestión de proyectos (tickets, roadmaps, requisitos)',
        others: 'Otros',
      },
    },
    ui: {
      next: 'Siguiente',
      back: 'Atrás',
      installingDependencies: 'instalando dependencias',
      confirm: 'Confirmar',
      skip: 'Saltar',
      connectGitHub: 'Conectar GitHub',
      grantPermissions: 'Otorgar permisos',
      redirectingToGitHub: 'Redirigiendo a GitHub...',
    },
    greetings: {
      morning: 'Buenos días',
      afternoon: 'Buenas tardes',
      evening: 'Buenas noches',
    },
    homePage: {
      inputPlaceholder: 'Trabaja en cualquier cosa',
      toolchainHeader: 'Cadena de herramientas',
      suggestedChatsHeader: 'Chats sugeridos',
      bottomNav: {
        home: 'Inicio',
        repo: 'Repo',
        chat: 'Chat',
        runtime: 'Runtime',
      },
    },
    roleSuggestions: {
      development: [
        'Revisar el flujo de autenticación en la API',
      ],
      projectManagement: [
        'Generar informe de progreso del sprint',
      ],
      infrastructure: [
        'Optimizar el pipeline de despliegue',
      ],
      media: [
        'Diseñar nuevo flujo de incorporación',
      ],
      workflow: [
        'Automatizar tareas repetitivas',
      ],
    },
    machineConf: {
      nameYourMachine: 'Nombra tu máquina',
      enterMachineName: 'Introduce el nombre de la máquina',
      settingUpMachine: 'Configurando máquina...',
      welcomeToPortable: 'Bienvenido a Portable',
      workstationCreated: 'Tu estación de trabajo ha sido creada exitosamente y está lista para usar.',
      proceed: 'Continuar',
      selectPlan: 'Seleccionar plan',
      startCodingToday: 'Comienza a programar hoy, actualiza cuando quieras',
      continue: 'Continuar',
      thankYouEarlyAccess: '¡Gracias por unirte a nuestro acceso anticipado!',
      thankYouPro: '¡Gracias por elegir Pro!',
      checkingAccess: 'Verificando acceso...',
      continueToApp: 'Continuar a la App',
      nextStepsButton: 'Siguientes Pasos',
      backToHome: 'Volver al Inicio',
      nextSteps: {
        earlyAccess: {
          mainAction: 'Nos pondremos en contacto pronto',
          timing: 'Busca un correo de nuestro equipo, normalmente dentro de 2 horas hábiles',
          items: [
            'Invitarte a unirte al programa de acceso anticipado',
            'Ayudarte a configurar la última versión de Portable',
            'Conectarte con nuestro equipo de desarrollo',
          ],
        },
        proPlan: {
          mainAction: 'Breve llamada de incorporación',
          timing: 'Nuestro equipo se comunicará por correo para programar una llamada de incorporación personalizada. O contáctanos en contact@portable.dev',
          items: [
            'Servicio de configuración personalizado para tu caso de uso',
            'Credenciales de acceso e incorporación personalizada',
            'Soporte directo para ponerte en marcha',
          ],
        },
      },
      pricing: {
        free: {
          price: 'Gratis',
          title: 'Acceso Anticipado',
          description: 'Accede a funciones de vanguardia y ayúdanos a mejorar la app',
          features: [
            'Todas las características del plan pro',
            'Últimas funciones a medida que se desarrollan',
            'Chat grupal directo con los desarrolladores',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: 'Para desarrolladores serios que necesitan trabajar en el teléfono',
          features: [
            'Integración completa con GitHub',
            'Proyectos activos ilimitados',
            '500 horas de servidor por mes',
            'Asistencia de codificación con IA',
            'Vista previa en vivo y pruebas con agentes',
            'Modo de voz avanzado',
          ],
        },
        perMonth: 'mes',
      },
      soldOutDialog: {
        title: '¡Gracias por tu interés!',
        message: 'Este plan está actualmente agotado, pero estamos trabajando duro para traerlo de vuelta pronto.',
        continueForFree: 'Continuar Gratis',
      },
    },
    grantPermissions: {
      title: 'Se Requieren Permisos Adicionales',
      subtitle: 'Portable necesita permisos adicionales de GitHub para acceder a tus repositorios y proporcionar funcionalidad completa.',
      requiredPermissions: 'PERMISOS REQUERIDOS:',
      permissions: {
        codeAccess: {
          title: 'Acceso de lectura y escritura al código',
          description: 'Permite a Portable clonar, enviar y gestionar tus repositorios.',
        },
        webhooks: {
          title: 'Gestionar webhooks',
          description: 'Permite a Portable configurar webhooks para actualizaciones en tiempo real.',
        },
        pullRequests: {
          title: 'Acceso a pull requests e issues',
          description: 'Permite a Portable ayudarte a gestionar tu flujo de desarrollo.',
        },
      },
      securityAlert: 'Tus datos están seguros. Todo el código se ejecuta en tu entorno aislado. Nunca almacenamos el contenido de tus repositorios.',
      authorizeButton: 'Autorizar GitHub',
      maybeLater: 'Quizás más tarde',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: '¡Bienvenido a Portable!',
          subtitle: 'Tu compañero móvil de GitHub con asistencia de IA. Programa, revisa y despliega desde cualquier lugar.',
          perfectFor: 'Perfecto para:',
          features: {
            bugFixes: 'Correcciones rápidas en movimiento',
            mobileDev: 'Desarrollo mobile-first',
            aiAssistance: 'Asistencia de código con IA',
            deployAnywhere: 'Despliega desde cualquier lugar',
          },
        },
        howItWorks: {
          title: 'Cómo funciona Portable',
          subtitle: 'Portable combina GitHub con IA para crear un poderoso flujo de desarrollo móvil',
          steps: {
            browse: { title: 'Navega GitHub', description: 'Accede a todos tus repositorios y issues desde tu teléfono' },
            chat: { title: 'Chatea con IA', description: 'Pide a Claude que te ayude con código, depuración y revisiones' },
            action: { title: 'Actúa', description: 'Sube cambios, crea PRs y gestiona tus proyectos' },
          },
        },
        almostReady: {
          title: '¡Casi listo!',
          subtitle: 'Tu espacio de trabajo se está preparando. Una vez listo, conectaremos tus repositorios de GitHub.',
          settingUp: 'Configurando tu entorno...',
          ready: '¡Espacio de trabajo listo!',
        },
      },
      navigation: {
        previous: 'Anterior',
        next: 'Siguiente',
        continue: 'Continuar',
        finishingSetup: 'Finalizando configuración...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: 'Verificando tu entorno...',
      connectingRepositories: 'Conectando tus repositorios...',
      waitingForServer: 'Esperando que el servidor se inicialice...',
      checkingServerStatus: 'Verificando estado del servidor',
      serverReady: '¡Servidor listo!',
      verificationTimeout: 'Tiempo de espera agotado - redirigiendo de todos modos...',
      verificationFailed: 'No se pudo verificar el estado del servidor - redirigiendo de todos modos...',
    },
    connectRepos: {
      title: 'Inicio de sesión con GitHub requerido',
      descriptionUpgrade: 'Para actualizar tus permisos, necesitas iniciar sesión con GitHub. Esto permitirá que Portable solicite acceso adicional a tus repositorios.',
      descriptionConnect: 'Para conectar tus repositorios, necesitas iniciar sesión con GitHub. Esto permitirá que Portable acceda a tu código y administre repositorios en tu nombre.',
      signingOut: 'Cerrando sesión...',
      signInButton: 'Iniciar sesión con GitHub',
      skipUpgrade: 'Continuar con permisos actuales',
      skipConnect: 'Omitir por ahora (funcionalidad limitada)',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: 'Entorno de código nativo móvil con IA',
      viewButton: 'Ver',
      installButton: 'Instalar',
      installTitle: 'Instalar Portable:',
      tapShare: 'Toca el botón Compartir',
      selectAddToHome: 'Selecciona "Añadir a pantalla de inicio"',
      tapAddToHome: 'Toca "Añadir a pantalla de inicio"',
      tapBrowserMenu: 'Toca el menú de tu navegador',
    },
  },
  fr: {
    languageSelection: {
      title: 'Choisissez votre langue',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: 'Choisissez votre thème',
    },
    roleSelection: {
      title: 'Comment utiliserez-vous Portable?',
      options: {
        development: 'Développement de logiciels',
        projectManagement: 'Gestion de projet',
        infrastructure: 'Infrastructure et DevOps',
        media: 'Médias et création',
        workflow: 'Automatisation des flux de travail',
      },
    },
    devtoolsSelection: {
      title: 'Ajouter des raccourcis de frameworks',
      subtitle: 'Vous pouvez toujours en ajouter plus tard.',
    },
    interestsSelection: {
      title: 'Que construirez-vous sur Portable?',
      options: {
        webdev: 'Site web ou application web (front-end ou full stack)',
        mobiledev: 'Application mobile (iOS, Android, multiplateforme)',
        backend: 'Services backend et APIs',
        scripts: 'Scripts / Automatisation / Outils internes',
        datascience: 'Projet de données, analyse ou ML',
        devops: 'Infrastructure / DevOps',
        gamedev: 'Jeu vidéo ou outils liés aux jeux',
        pm: 'Gestion de projet (tickets, feuilles de route, exigences)',
        others: 'Autres',
      },
    },
    ui: {
      next: 'Suivant',
      back: 'Retour',
      installingDependencies: 'installation des dépendances',
      confirm: 'Confirmer',
      skip: 'Passer',
      connectGitHub: 'Connecter GitHub',
      grantPermissions: 'Accorder les permissions',
      redirectingToGitHub: 'Redirection vers GitHub...',
    },
    greetings: {
      morning: 'Bonjour',
      afternoon: 'Bon après-midi',
      evening: 'Bonsoir',
    },
    homePage: {
      inputPlaceholder: 'Travailler sur quoi que ce soit',
      toolchainHeader: 'Chaîne d\'outils',
      suggestedChatsHeader: 'Chats suggérés',
      bottomNav: {
        home: 'Accueil',
        repo: 'Repo',
        chat: 'Chat',
        runtime: 'Runtime',
      },
    },
    roleSuggestions: {
      development: [
        'Examiner le flux d\'authentification dans l\'API',
      ],
      projectManagement: [
        'Générer un rapport de progression du sprint',
      ],
      infrastructure: [
        'Optimiser le pipeline de déploiement',
      ],
      media: [
        'Concevoir un nouveau flux d\'intégration',
      ],
      workflow: [
        'Automatiser les tâches répétitives',
      ],
    },
    machineConf: {
      nameYourMachine: 'Nommez votre machine',
      enterMachineName: 'Entrez le nom de la machine',
      settingUpMachine: 'Configuration de la machine...',
      welcomeToPortable: 'Bienvenue sur Portable',
      workstationCreated: 'Votre poste de travail a été créé avec succès et est prêt à être utilisé.',
      proceed: 'Continuer',
      selectPlan: 'Sélectionner un plan',
      startCodingToday: 'Commencez à coder aujourd\'hui, mettez à niveau à tout moment',
      continue: 'Continuer',
      thankYouEarlyAccess: 'Merci d\'avoir rejoint notre accès anticipé!',
      thankYouPro: 'Merci d\'avoir choisi Pro!',
      checkingAccess: 'Vérification de l\'accès...',
      continueToApp: 'Continuer vers l\'App',
      nextStepsButton: 'Étapes Suivantes',
      backToHome: 'Retour à l\'Accueil',
      nextSteps: {
        earlyAccess: {
          mainAction: 'Nous vous contacterons bientôt',
          timing: 'Attendez un email de notre équipe, généralement dans les 2 heures ouvrables',
          items: [
            'Vous inviter à rejoindre le programme d\'accès anticipé',
            'Vous aider à configurer la dernière version de Portable',
            'Vous mettre en contact avec notre équipe de développement',
          ],
        },
        proPlan: {
          mainAction: 'Bref appel d\'intégration',
          timing: 'Notre équipe vous contactera par email pour planifier un appel d\'intégration personnalisé. Ou contactez-nous à contact@portable.dev',
          items: [
            'Service de configuration personnalisé pour votre cas d\'utilisation',
            'Identifiants d\'accès et intégration personnalisée',
            'Support direct pour vous aider à démarrer',
          ],
        },
      },
      pricing: {
        free: {
          price: 'Gratuit',
          title: 'Accès Anticipé',
          description: 'Accédez aux fonctionnalités de pointe et aidez-nous à améliorer l\'application',
          features: [
            'Toutes les fonctionnalités du plan pro',
            'Dernières fonctionnalités au fur et à mesure de leur développement',
            'Chat de groupe direct avec les développeurs',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: 'Pour les développeurs sérieux qui ont besoin de travailler sur le téléphone',
          features: [
            'Intégration complète avec GitHub',
            'Projets actifs illimités',
            '500 heures de serveur par mois',
            'Assistance au codage par IA',
            'Aperçu en direct et tests d\'agents',
            'Mode vocal avancé',
          ],
        },
        perMonth: 'mois',
      },
      soldOutDialog: {
        title: 'Merci pour votre intérêt!',
        message: 'Ce plan est actuellement épuisé, mais nous travaillons dur pour le ramener bientôt.',
        continueForFree: 'Continuer Gratuitement',
      },
    },
    grantPermissions: {
      title: 'Autorisations Supplémentaires Requises',
      subtitle: 'Portable a besoin d\'autorisations GitHub supplémentaires pour accéder à vos dépôts et fournir une fonctionnalité complète.',
      requiredPermissions: 'AUTORISATIONS REQUISES:',
      permissions: {
        codeAccess: {
          title: 'Accès en lecture et écriture au code',
          description: 'Permet à Portable de cloner, pousser et gérer vos dépôts.',
        },
        webhooks: {
          title: 'Gérer les webhooks',
          description: 'Permet à Portable de configurer des webhooks pour les mises à jour en temps réel.',
        },
        pullRequests: {
          title: 'Accès aux pull requests et issues',
          description: 'Permet à Portable de vous aider à gérer votre flux de développement.',
        },
      },
      securityAlert: 'Vos données sont sécurisées. Tout le code s\'exécute dans votre environnement isolé. Nous ne stockons jamais le contenu de vos dépôts.',
      authorizeButton: 'Autoriser GitHub',
      maybeLater: 'Peut-être plus tard',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: 'Bienvenue sur Portable!',
          subtitle: 'Votre compagnon GitHub mobile avec assistance IA. Codez, révisez et déployez de n\'importe où.',
          perfectFor: 'Parfait pour:',
          features: {
            bugFixes: 'Corrections rapides en déplacement',
            mobileDev: 'Développement mobile-first',
            aiAssistance: 'Assistance au code par IA',
            deployAnywhere: 'Déployez de n\'importe où',
          },
        },
        howItWorks: {
          title: 'Comment fonctionne Portable',
          subtitle: 'Portable combine GitHub avec l\'IA pour créer un puissant flux de développement mobile',
          steps: {
            browse: { title: 'Parcourir GitHub', description: 'Accédez à tous vos dépôts et issues depuis votre téléphone' },
            chat: { title: 'Discuter avec l\'IA', description: 'Demandez à Claude de vous aider avec le code, le débogage et les révisions' },
            action: { title: 'Agir', description: 'Poussez des modifications, créez des PRs et gérez vos projets' },
          },
        },
        almostReady: {
          title: 'Presque prêt!',
          subtitle: 'Votre espace de travail est en préparation. Une fois prêt, nous connecterons vos dépôts GitHub.',
          settingUp: 'Configuration de votre environnement...',
          ready: 'Espace de travail prêt!',
        },
      },
      navigation: {
        previous: 'Précédent',
        next: 'Suivant',
        continue: 'Continuer',
        finishingSetup: 'Finalisation...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: 'Vérification de votre environnement...',
      connectingRepositories: 'Connexion de vos dépôts...',
      waitingForServer: 'En attente de l\'initialisation du serveur...',
      checkingServerStatus: 'Vérification de l\'état du serveur',
      serverReady: 'Serveur prêt!',
      verificationTimeout: 'Délai d\'attente dépassé - redirection quand même...',
      verificationFailed: 'Impossible de vérifier l\'état du serveur - redirection quand même...',
    },
    connectRepos: {
      title: 'Connexion GitHub requise',
      descriptionUpgrade: 'Pour mettre à jour vos permissions, vous devez vous connecter avec GitHub. Cela permettra à Portable de demander un accès supplémentaire à vos dépôts.',
      descriptionConnect: 'Pour connecter vos dépôts, vous devez vous connecter avec GitHub. Cela permettra à Portable d\'accéder à votre code et de gérer les dépôts en votre nom.',
      signingOut: 'Déconnexion...',
      signInButton: 'Se connecter avec GitHub',
      skipUpgrade: 'Continuer avec les permissions actuelles',
      skipConnect: 'Ignorer pour l\'instant (fonctionnalité limitée)',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: 'Environnement de code natif mobile avec IA',
      viewButton: 'Voir',
      installButton: 'Installer',
      installTitle: 'Installer Portable:',
      tapShare: 'Appuyez sur le bouton Partager',
      selectAddToHome: 'Sélectionnez "Ajouter à l\'écran d\'accueil"',
      tapAddToHome: 'Appuyez sur "Ajouter à l\'écran d\'accueil"',
      tapBrowserMenu: 'Appuyez sur le menu de votre navigateur',
    },
  },
  de: {
    languageSelection: {
      title: 'Wählen Sie Ihre Sprache',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: 'Wählen Sie Ihr Thema',
    },
    roleSelection: {
      title: 'Wie werden Sie Portable nutzen?',
      options: {
        development: 'Softwareentwicklung',
        projectManagement: 'Projektmanagement',
        infrastructure: 'Infrastruktur und DevOps',
        media: 'Medien und Kreativität',
        workflow: 'Workflow-Automatisierung',
      },
    },
    devtoolsSelection: {
      title: 'Framework-Verknüpfungen hinzufügen',
      subtitle: 'Sie können später jederzeit mehr hinzufügen.',
    },
    interestsSelection: {
      title: 'Was werden Sie auf Portable bauen?',
      options: {
        webdev: 'Website oder Web-App (Front-End oder Full-Stack)',
        mobiledev: 'Mobile App (iOS, Android, plattformübergreifend)',
        backend: 'Backend-Dienste und APIs',
        scripts: 'Skripte / Automatisierung / Interne Tools',
        datascience: 'Daten-, Analyse- oder ML-Projekt',
        devops: 'Infrastruktur / DevOps',
        gamedev: 'Videospiel oder spielbezogene Tools',
        pm: 'Projektmanagement (Tickets, Roadmaps, Anforderungen)',
        others: 'Andere',
      },
    },
    ui: {
      next: 'Weiter',
      back: 'Zurück',
      installingDependencies: 'Abhängigkeiten installieren',
      confirm: 'Bestätigen',
      skip: 'Überspringen',
      connectGitHub: 'GitHub verbinden',
      grantPermissions: 'Berechtigungen erteilen',
      redirectingToGitHub: 'Weiterleitung zu GitHub...',
    },
    greetings: {
      morning: 'Guten Morgen',
      afternoon: 'Guten Tag',
      evening: 'Guten Abend',
    },
    homePage: {
      inputPlaceholder: 'An irgendetwas arbeiten',
      toolchainHeader: 'Toolchain',
      suggestedChatsHeader: 'Vorgeschlagene Chats',
      bottomNav: {
        home: 'Startseite',
        repo: 'Repo',
        chat: 'Chat',
        runtime: 'Runtime',
      },
    },
    roleSuggestions: {
      development: [
        'Authentifizierungsablauf in der API überprüfen',
      ],
      projectManagement: [
        'Sprint-Fortschrittsbericht generieren',
      ],
      infrastructure: [
        'Deployment-Pipeline optimieren',
      ],
      media: [
        'Neuen Onboarding-Ablauf entwerfen',
      ],
      workflow: [
        'Repetitive Aufgaben automatisieren',
      ],
    },
    machineConf: {
      nameYourMachine: 'Benennen Sie Ihre Maschine',
      enterMachineName: 'Maschinenname eingeben',
      settingUpMachine: 'Maschine wird eingerichtet...',
      welcomeToPortable: 'Willkommen bei Portable',
      workstationCreated: 'Ihre Workstation wurde erfolgreich erstellt und ist einsatzbereit.',
      proceed: 'Fortfahren',
      selectPlan: 'Plan auswählen',
      startCodingToday: 'Heute mit dem Programmieren beginnen, jederzeit upgraden',
      continue: 'Weiter',
      thankYouEarlyAccess: 'Danke, dass Sie unserem Early Access beigetreten sind!',
      thankYouPro: 'Danke, dass Sie sich für Pro entschieden haben!',
      checkingAccess: 'Zugang wird überprüft...',
      continueToApp: 'Weiter zur App',
      nextStepsButton: 'Nächste Schritte',
      backToHome: 'Zurück zur Startseite',
      nextSteps: {
        earlyAccess: {
          mainAction: 'Wir werden Sie in Kürze kontaktieren',
          timing: 'Achten Sie auf eine E-Mail von unserem Team, normalerweise innerhalb von 2 Geschäftsstunden',
          items: [
            'Sie zum Early-Access-Programm einladen',
            'Ihnen bei der Einrichtung der neuesten Version von Portable helfen',
            'Sie mit unserem Entwicklerteam verbinden',
          ],
        },
        proPlan: {
          mainAction: 'Kurzes Onboarding-Gespräch',
          timing: 'Unser Team meldet sich per E-Mail, um ein persönliches Onboarding-Gespräch zu vereinbaren. Oder kontaktieren Sie uns unter contact@portable.dev',
          items: [
            'Maßgeschneiderter Einrichtungsservice für Ihren Anwendungsfall',
            'Zugangsdaten und personalisiertes Onboarding',
            'Direkter Support, um Sie schnell startklar zu machen',
          ],
        },
      },
      pricing: {
        free: {
          price: 'Kostenlos',
          title: 'Frühzugang',
          description: 'Zugriff auf modernste Funktionen und helfen Sie uns, die App zu verbessern',
          features: [
            'Alle Funktionen des Pro-Plans',
            'Neueste Funktionen, sobald sie entwickelt werden',
            'Direkter Gruppenchat mit den Entwicklern',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: 'Für ernsthafte Entwickler, die am Telefon arbeiten müssen',
          features: [
            'Vollständige GitHub-Integration',
            'Unbegrenzte aktive Projekte',
            '500 Serverstunden pro Monat',
            'KI-Programmierassistenz',
            'Live-Vorschau und Agententests',
            'Erweiterter Sprachmodus',
          ],
        },
        perMonth: 'Monat',
      },
      soldOutDialog: {
        title: 'Vielen Dank für Ihr Interesse!',
        message: 'Dieser Plan ist derzeit ausverkauft, aber wir arbeiten hart daran, ihn bald zurückzubringen.',
        continueForFree: 'Kostenlos fortfahren',
      },
    },
    grantPermissions: {
      title: 'Zusätzliche Berechtigungen Erforderlich',
      subtitle: 'Portable benötigt zusätzliche GitHub-Berechtigungen, um auf Ihre Repositories zuzugreifen und volle Funktionalität zu bieten.',
      requiredPermissions: 'ERFORDERLICHE BERECHTIGUNGEN:',
      permissions: {
        codeAccess: {
          title: 'Lese- und Schreibzugriff auf Code',
          description: 'Ermöglicht Portable, Ihre Repositories zu klonen, zu pushen und zu verwalten.',
        },
        webhooks: {
          title: 'Webhooks verwalten',
          description: 'Ermöglicht Portable, Webhooks für Echtzeit-Updates einzurichten.',
        },
        pullRequests: {
          title: 'Zugriff auf Pull Requests und Issues',
          description: 'Ermöglicht Portable, Sie bei der Verwaltung Ihres Entwicklungs-Workflows zu unterstützen.',
        },
      },
      securityAlert: 'Ihre Daten sind sicher. Der gesamte Code läuft in Ihrer isolierten Umgebung. Wir speichern niemals Ihre Repository-Inhalte.',
      authorizeButton: 'GitHub autorisieren',
      maybeLater: 'Vielleicht später',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: 'Willkommen bei Portable!',
          subtitle: 'Ihr mobiler GitHub-Begleiter mit KI-Unterstützung. Programmieren, überprüfen und bereitstellen von überall.',
          perfectFor: 'Perfekt für:',
          features: {
            bugFixes: 'Schnelle Fehlerbehebungen unterwegs',
            mobileDev: 'Mobile-First-Entwicklung',
            aiAssistance: 'KI-gestützte Code-Assistenz',
            deployAnywhere: 'Von überall bereitstellen',
          },
        },
        howItWorks: {
          title: 'Wie Portable funktioniert',
          subtitle: 'Portable kombiniert GitHub mit KI für einen leistungsstarken mobilen Entwicklungs-Workflow',
          steps: {
            browse: { title: 'GitHub durchsuchen', description: 'Greifen Sie von Ihrem Telefon auf alle Ihre Repositories und Issues zu' },
            chat: { title: 'Mit KI chatten', description: 'Bitten Sie Claude um Hilfe beim Programmieren, Debuggen und Überprüfen' },
            action: { title: 'Handeln', description: 'Änderungen pushen, PRs erstellen und Ihre Projekte verwalten' },
          },
        },
        almostReady: {
          title: 'Fast fertig!',
          subtitle: 'Ihr Arbeitsbereich wird vorbereitet. Sobald er fertig ist, verbinden wir Ihre GitHub-Repositories.',
          settingUp: 'Umgebung wird eingerichtet...',
          ready: 'Arbeitsbereich bereit!',
        },
      },
      navigation: {
        previous: 'Zurück',
        next: 'Weiter',
        continue: 'Fortfahren',
        finishingSetup: 'Einrichtung wird abgeschlossen...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: 'Umgebung wird überprüft...',
      connectingRepositories: 'Repositories werden verbunden...',
      waitingForServer: 'Warten auf Server-Initialisierung...',
      checkingServerStatus: 'Server-Status wird überprüft',
      serverReady: 'Server bereit!',
      verificationTimeout: 'Zeitüberschreitung - Weiterleitung trotzdem...',
      verificationFailed: 'Server-Status konnte nicht überprüft werden - Weiterleitung trotzdem...',
    },
    connectRepos: {
      title: 'GitHub-Anmeldung erforderlich',
      descriptionUpgrade: 'Um Ihre Berechtigungen zu aktualisieren, müssen Sie sich bei GitHub anmelden. Dies ermöglicht Portable, zusätzlichen Zugriff auf Ihre Repositories anzufordern.',
      descriptionConnect: 'Um Ihre Repositories zu verbinden, müssen Sie sich bei GitHub anmelden. Dies ermöglicht Portable, auf Ihren Code zuzugreifen und Repositories in Ihrem Namen zu verwalten.',
      signingOut: 'Abmelden...',
      signInButton: 'Mit GitHub anmelden',
      skipUpgrade: 'Mit aktuellen Berechtigungen fortfahren',
      skipConnect: 'Vorerst überspringen (eingeschränkte Funktionalität)',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: 'Native mobile KI-Code-Umgebung',
      viewButton: 'Ansehen',
      installButton: 'Installieren',
      installTitle: 'Portable installieren:',
      tapShare: 'Tippen Sie auf die Teilen-Schaltfläche',
      selectAddToHome: 'Wählen Sie "Zum Startbildschirm hinzufügen"',
      tapAddToHome: 'Tippen Sie auf "Zum Startbildschirm hinzufügen"',
      tapBrowserMenu: 'Tippen Sie auf das Browser-Menü',
    },
  },
  zh: {
    languageSelection: {
      title: '选择您的语言',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: '选择您的主题',
    },
    roleSelection: {
      title: '您将如何使用Portable？',
      options: {
        development: '软件开发',
        projectManagement: '项目管理',
        infrastructure: '基础设施和DevOps',
        media: '媒体和创意',
        workflow: '工作流程自动化',
      },
    },
    devtoolsSelection: {
      title: '添加框架快捷方式',
      subtitle: '您以后随时可以添加更多。',
    },
    interestsSelection: {
      title: '您将在Portable上构建什么？',
      options: {
        webdev: '网站或Web应用（前端或全栈）',
        mobiledev: '移动应用（iOS、Android、跨平台）',
        backend: '后端服务和API',
        scripts: '脚本/自动化/内部工具',
        datascience: '数据、分析或机器学习项目',
        devops: '基础设施/DevOps',
        gamedev: '视频游戏或游戏相关工具',
        pm: '项目管理（工单、路线图、需求）',
        others: '其他',
      },
    },
    ui: {
      next: '下一步',
      back: '返回',
      installingDependencies: '正在安装依赖项',
      confirm: '确认',
      skip: '跳过',
      connectGitHub: '连接 GitHub',
      grantPermissions: '授予权限',
      redirectingToGitHub: '正在重定向到 GitHub...',
    },
    greetings: {
      morning: '早上好',
      afternoon: '下午好',
      evening: '晚上好',
    },
    homePage: {
      inputPlaceholder: '处理任何事情',
      toolchainHeader: '工具链',
      suggestedChatsHeader: '建议的聊天',
      bottomNav: {
        home: '首页',
        repo: '仓库',
        chat: '聊天',
        runtime: '运行时',
      },
    },
    roleSuggestions: {
      development: [
        '审查API中的身份验证流程',
      ],
      projectManagement: [
        '生成冲刺进度报告',
      ],
      infrastructure: [
        '优化部署管道',
      ],
      media: [
        '设计新的入门流程',
      ],
      workflow: [
        '自动化重复性任务',
      ],
    },
    machineConf: {
      nameYourMachine: '为您的机器命名',
      enterMachineName: '输入机器名称',
      settingUpMachine: '正在设置机器...',
      welcomeToPortable: '欢迎使用Portable',
      workstationCreated: '您的工作站已成功创建并准备就绪。',
      proceed: '继续',
      selectPlan: '选择计划',
      startCodingToday: '今天开始编码，随时升级',
      continue: '继续',
      thankYouEarlyAccess: '感谢您加入我们的抢先体验！',
      thankYouPro: '感谢您选择专业版！',
      checkingAccess: '正在检查访问权限...',
      continueToApp: '继续进入应用',
      nextStepsButton: '下一步',
      backToHome: '返回首页',
      nextSteps: {
        earlyAccess: {
          mainAction: '我们将很快与您联系',
          timing: '请查收我们团队的邮件，通常在2个工作小时内',
          items: [
            '邀请您加入抢先体验计划',
            '帮助您设置最新版本的Portable',
            '将您与我们的开发团队联系起来',
          ],
        },
        proPlan: {
          mainAction: '简短的入职通话',
          timing: '我们的团队将通过电子邮件联系您，安排个性化入职通话。或联系我们：contact@portable.dev',
          items: [
            '针对您用例的定制设置服务',
            '访问凭证和个性化入职',
            '直接支持帮助您快速上手',
          ],
        },
      },
      pricing: {
        free: {
          price: '免费',
          title: '抢先体验',
          description: '访问尖端功能并帮助我们改进应用',
          features: [
            'Pro计划的所有功能',
            '最新功能随开发而来',
            '与开发者直接群聊',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: '适合需要在手机上工作的认真开发者',
          features: [
            '完整的GitHub集成',
            '无限活动项目',
            '每月500服务器小时',
            'AI编码辅助',
            '实时预览和代理测试',
            '高级语音模式',
          ],
        },
        perMonth: '月',
      },
      soldOutDialog: {
        title: '感谢您的关注！',
        message: '此计划目前已售罄，但我们正在努力尽快恢复。',
        continueForFree: '免费继续',
      },
    },
    grantPermissions: {
      title: '需要额外权限',
      subtitle: 'Portable需要额外的GitHub权限来访问您的仓库并提供完整功能。',
      requiredPermissions: '所需权限：',
      permissions: {
        codeAccess: {
          title: '代码读写权限',
          description: '允许Portable克隆、推送和管理您的仓库。',
        },
        webhooks: {
          title: '管理Webhooks',
          description: '允许Portable设置Webhooks以实现实时更新。',
        },
        pullRequests: {
          title: '访问Pull Request和Issue',
          description: '允许Portable帮助您管理开发工作流程。',
        },
      },
      securityAlert: '您的数据是安全的。所有代码都在您的隔离环境中运行。我们从不存储您的仓库内容。',
      authorizeButton: '授权GitHub',
      maybeLater: '稍后再说',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: '欢迎使用Portable！',
          subtitle: '您的移动GitHub伴侣，配备AI助手。随时随地编码、审查和部署。',
          perfectFor: '非常适合：',
          features: {
            bugFixes: '随时快速修复bug',
            mobileDev: '移动优先开发',
            aiAssistance: 'AI驱动的代码辅助',
            deployAnywhere: '随时随地部署',
          },
        },
        howItWorks: {
          title: 'Portable如何工作',
          subtitle: 'Portable将GitHub与AI结合，打造强大的移动开发工作流',
          steps: {
            browse: { title: '浏览GitHub', description: '从手机访问所有仓库和问题' },
            chat: { title: '与AI对话', description: '让Claude帮助您编码、调试和审查' },
            action: { title: '采取行动', description: '推送更改、创建PR和管理项目' },
          },
        },
        almostReady: {
          title: '即将就绪！',
          subtitle: '正在准备您的工作空间。准备好后，我们将连接您的GitHub仓库。',
          settingUp: '正在设置环境...',
          ready: '工作空间就绪！',
        },
      },
      navigation: {
        previous: '上一步',
        next: '下一步',
        continue: '继续',
        finishingSetup: '正在完成设置...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: '正在检查环境...',
      connectingRepositories: '正在连接仓库...',
      waitingForServer: '等待服务器初始化...',
      checkingServerStatus: '正在检查服务器状态',
      serverReady: '服务器就绪！',
      verificationTimeout: '超时 - 仍在重定向...',
      verificationFailed: '无法验证服务器状态 - 仍在重定向...',
    },
    connectRepos: {
      title: '需要GitHub登录',
      descriptionUpgrade: '要升级您的权限，您需要使用GitHub登录。这将允许Portable请求对您仓库的额外访问权限。',
      descriptionConnect: '要连接您的仓库，您需要使用GitHub登录。这将允许Portable访问您的代码并代表您管理仓库。',
      signingOut: '正在退出...',
      signInButton: '使用GitHub登录',
      skipUpgrade: '继续使用当前权限',
      skipConnect: '暂时跳过（功能受限）',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: '原生移动AI代码环境',
      viewButton: '查看',
      installButton: '安装',
      installTitle: '安装Portable：',
      tapShare: '点击分享按钮',
      selectAddToHome: '选择"添加到主屏幕"',
      tapAddToHome: '点击"添加到主屏幕"',
      tapBrowserMenu: '点击浏览器菜单',
    },
  },
  ja: {
    languageSelection: {
      title: '言語を選択',
      options: {
        en: 'English',
        es: 'Español',
        fr: 'Français',
        de: 'Deutsch',
        zh: '中文',
        ja: '日本語',
      },
    },
    themeSelection: {
      title: 'テーマを選択',
    },
    roleSelection: {
      title: 'Portableをどのように使用しますか？',
      options: {
        development: 'ソフトウェア開発',
        projectManagement: 'プロジェクト管理',
        infrastructure: 'インフラとDevOps',
        media: 'メディアとクリエイティブ',
        workflow: 'ワークフロー自動化',
      },
    },
    devtoolsSelection: {
      title: 'フレームワークのショートカットを追加',
      subtitle: '後でいつでも追加できます。',
    },
    interestsSelection: {
      title: 'Portableで何を作りますか？',
      options: {
        webdev: 'ウェブサイトまたはウェブアプリ（フロントエンドまたはフルスタック）',
        mobiledev: 'モバイルアプリ（iOS、Android、クロスプラットフォーム）',
        backend: 'バックエンドサービスとAPI',
        scripts: 'スクリプト/自動化/内部ツール',
        datascience: 'データ、分析、またはMLプロジェクト',
        devops: 'インフラストラクチャ/DevOps',
        gamedev: 'ビデオゲームまたはゲーム関連ツール',
        pm: 'プロジェクト管理（チケット、ロードマップ、要件）',
        others: 'その他',
      },
    },
    ui: {
      next: '次へ',
      back: '戻る',
      installingDependencies: '依存関係をインストール中',
      confirm: '確認',
      skip: 'スキップ',
      connectGitHub: 'GitHub に接続',
      grantPermissions: '権限を付与',
      redirectingToGitHub: 'GitHub にリダイレクト中...',
    },
    greetings: {
      morning: 'おはよう',
      afternoon: 'こんにちは',
      evening: 'こんばんは',
    },
    homePage: {
      inputPlaceholder: '何でも作業',
      toolchainHeader: 'ツールチェーン',
      suggestedChatsHeader: '推奨チャット',
      bottomNav: {
        home: 'ホーム',
        repo: 'リポジトリ',
        chat: 'チャット',
        runtime: 'ランタイム',
      },
    },
    roleSuggestions: {
      development: [
        'API内の認証フローを確認する',
      ],
      projectManagement: [
        'スプリント進捗レポートを生成する',
      ],
      infrastructure: [
        'デプロイメントパイプラインを最適化する',
      ],
      media: [
        '新しいオンボーディングフローをデザインする',
      ],
      workflow: [
        '繰り返しタスクを自動化する',
      ],
    },
    machineConf: {
      nameYourMachine: 'マシンに名前を付ける',
      enterMachineName: 'マシン名を入力',
      settingUpMachine: 'マシンを設定中...',
      welcomeToPortable: 'Portableへようこそ',
      workstationCreated: 'ワークステーションが正常に作成され、使用準備が整いました。',
      proceed: '続ける',
      selectPlan: 'プランを選択',
      startCodingToday: '今日からコーディング、いつでもアップグレード',
      continue: '続ける',
      thankYouEarlyAccess: '早期アクセスにご参加いただきありがとうございます！',
      thankYouPro: 'Proをお選びいただきありがとうございます！',
      checkingAccess: 'アクセスを確認中...',
      continueToApp: 'アプリへ進む',
      nextStepsButton: '次のステップ',
      backToHome: 'ホームに戻る',
      nextSteps: {
        earlyAccess: {
          mainAction: '近日中にご連絡いたします',
          timing: 'チームからのメールをお待ちください。通常2営業時間以内にお届けします',
          items: [
            '早期アクセスプログラムへのご招待',
            'Portableの最新バージョンのセットアップサポート',
            '開発チームとの接続',
          ],
        },
        proPlan: {
          mainAction: '簡単なオンボーディング通話',
          timing: 'チームがメールでパーソナライズされたオンボーディング通話をスケジュールします。または contact@portable.dev までお問い合わせください',
          items: [
            'お客様のユースケースに合わせたカスタムセットアップサービス',
            'アクセス認証情報とパーソナライズされたオンボーディング',
            'すぐに始められる直接サポート',
          ],
        },
      },
      pricing: {
        free: {
          price: '無料',
          title: '早期アクセス',
          description: '最先端の機能にアクセスし、アプリの改善にご協力ください',
          features: [
            'Proプランのすべての機能',
            '開発中の最新機能',
            '開発者との直接グループチャット',
          ],
        },
        pro: {
          price: '$34.99',
          title: 'Pro',
          description: '電話で作業する必要がある本格的な開発者向け',
          features: [
            '完全なGitHub統合',
            '無制限のアクティブプロジェクト',
            '月間500サーバー時間',
            'AIコーディング支援',
            'ライブプレビューとエージェントテスト',
            '高度な音声モード',
          ],
        },
        perMonth: '月',
      },
      soldOutDialog: {
        title: 'ご関心をお寄せいただきありがとうございます！',
        message: 'このプランは現在完売していますが、早期復活に向けて懸命に取り組んでいます。',
        continueForFree: '無料で続ける',
      },
    },
    grantPermissions: {
      title: '追加権限が必要です',
      subtitle: 'Portableがリポジトリにアクセスし、完全な機能を提供するには、追加のGitHub権限が必要です。',
      requiredPermissions: '必要な権限：',
      permissions: {
        codeAccess: {
          title: 'コードの読み書きアクセス',
          description: 'Portableがリポジトリのクローン、プッシュ、管理を行えるようになります。',
        },
        webhooks: {
          title: 'Webhookの管理',
          description: 'Portableがリアルタイム更新用のWebhookを設定できるようになります。',
        },
        pullRequests: {
          title: 'プルリクエストとイシューへのアクセス',
          description: 'Portableが開発ワークフローの管理をサポートできるようになります。',
        },
      },
      securityAlert: 'データは安全です。すべてのコードは分離された環境で実行されます。リポジトリの内容を保存することはありません。',
      authorizeButton: 'GitHubを認証',
      maybeLater: '後で',
    },
    welcomeSlides: {
      slides: {
        welcome: {
          title: 'Portableへようこそ！',
          subtitle: 'AIアシスタント付きのモバイルGitHubコンパニオン。どこからでもコード、レビュー、デプロイ。',
          perfectFor: '最適な用途：',
          features: {
            bugFixes: '外出先での素早いバグ修正',
            mobileDev: 'モバイルファースト開発',
            aiAssistance: 'AIによるコード支援',
            deployAnywhere: 'どこからでもデプロイ',
          },
        },
        howItWorks: {
          title: 'Portableの仕組み',
          subtitle: 'PortableはGitHubとAIを組み合わせて強力なモバイル開発ワークフローを実現します',
          steps: {
            browse: { title: 'GitHubを閲覧', description: 'スマートフォンからすべてのリポジトリとイシューにアクセス' },
            chat: { title: 'AIとチャット', description: 'Claudeにコーディング、デバッグ、レビューのサポートを依頼' },
            action: { title: 'アクション実行', description: '変更をプッシュし、PRを作成し、プロジェクトを管理' },
          },
        },
        almostReady: {
          title: 'もうすぐ準備完了！',
          subtitle: 'ワークスペースを準備しています。準備ができたら、GitHubリポジトリを接続します。',
          settingUp: '環境を設定中...',
          ready: 'ワークスペース準備完了！',
        },
      },
      navigation: {
        previous: '前へ',
        next: '次へ',
        continue: '続ける',
        finishingSetup: 'セットアップを完了中...',
      },
    },
    provisioningStatus: {
      checkingEnvironment: '環境を確認中...',
      connectingRepositories: 'リポジトリを接続中...',
      waitingForServer: 'サーバーの初期化を待機中...',
      checkingServerStatus: 'サーバーの状態を確認中',
      serverReady: 'サーバー準備完了！',
      verificationTimeout: 'タイムアウト - とにかくリダイレクト中...',
      verificationFailed: 'サーバーの状態を確認できませんでした - とにかくリダイレクト中...',
    },
    connectRepos: {
      title: 'GitHubログインが必要です',
      descriptionUpgrade: '権限をアップグレードするには、GitHubでサインインする必要があります。これにより、Portableがリポジトリへの追加アクセスを要求できるようになります。',
      descriptionConnect: 'リポジトリを接続するには、GitHubでサインインする必要があります。これにより、Portableがコードにアクセスし、あなたに代わってリポジトリを管理できるようになります。',
      signingOut: 'サインアウト中...',
      signInButton: 'GitHubでサインイン',
      skipUpgrade: '現在の権限で続ける',
      skipConnect: '今はスキップ（機能制限あり）',
    },
    installPrompt: {
      appName: 'Portable',
      company: 'VolterAI Inc.',
      tagline: 'ネイティブモバイルAIコード環境',
      viewButton: '表示',
      installButton: 'インストール',
      installTitle: 'Portableをインストール：',
      tapShare: '共有ボタンをタップ',
      selectAddToHome: '「ホーム画面に追加」を選択',
      tapAddToHome: '「ホーム画面に追加」をタップ',
      tapBrowserMenu: 'ブラウザのメニューをタップ',
    },
  },
}

/**
 * Get translations for a specific language
 * Falls back to English if language not found
 */
export function getTranslations(language: string): OnboardingTranslations {
  return translations[language as SupportedLanguage] || translations.en
}

/**
 * Get specific translation key path
 * Example: t('en', 'roleSelection.title')
 */
export function t(language: string, keyPath: string): string {
  const trans = getTranslations(language)
  const keys = keyPath.split('.')
  let result: any = trans

  for (const key of keys) {
    result = result?.[key]
    if (result === undefined) {
      console.warn(`Translation key not found: ${keyPath} for language: ${language}`)
      return keyPath
    }
  }

  return result as string
}
